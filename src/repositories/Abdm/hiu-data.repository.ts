import { MssqlParameter } from "typeorm/index.js";
import { HiuError, type SessionStatus } from "../../services/Abdm/hiu/hiu-enums.js";
import { errorCodeOf, RecordPurgeError, retryTransient, sqlErrorNumber, TRANSIENT_RETRY_DELAYS_MS, type RetryOptions } from "../../services/Abdm/hiu/hiu-db-errors.js";
import type {
    HiuDataArtefact,
    HiuDataRequestChanges,
    HiuDataRequestRow,
    HiuDataStore,
    HiuRecordRow,
    NewHiuDataRequest,
    NewHiuRecord,
} from "../../services/Abdm/hiu/hiu-data-flow.service.js";
import type { HiuMaintenanceStore } from "../../services/Abdm/hiu/hiu-maintenance.service.js";

/**
 * The HIU data flow's reads and writes: AbdmHiuDataRequests and AbdmHiuRecords, and the artefact
 * columns the data flow needs. Raw SQL with @0 parameters, so every claim is one atomic statement
 * (UPDATE ... OUTPUT ... WHERE <still unclaimed>) and safe across instances.
 *
 * Times are always passed in from JS as datetime2(3) parameters, never compared with GETDATE():
 * the mssql driver runs with useUTC=false, so both sides must come from JS Dates.
 */

export type HiuQuery = (sql: string, parameters?: unknown[]) => Promise<any>;

/** SQL Server's duplicate-key errors: unique constraint (2627) and unique index (2601). */
const DUPLICATE_KEY_ERRORS = new Set([2627, 2601]);

export const isDuplicateKeyError = (error: any): boolean => DUPLICATE_KEY_ERRORS.has(sqlErrorNumber(error));

/** Raised by addPage's own THROW when the artefact or the transfer closed before the page was stored. */
export const PAGE_CLOSED_ERROR = 50_001;
const isPageClosedError = (error: any): boolean => sqlErrorNumber(error) === PAGE_CLOSED_ERROR;

/** Runs tasks one at a time, in the order they were queued; a task that fails does not stop the next. */
export class SerialQueue {
    private tail: Promise<unknown> = Promise.resolve();

    run<T>(task: () => Promise<T>): Promise<T> {
        const result = this.tail.then(task);
        this.tail = result.catch(() => undefined);
        return result;
    }
}

/** How long one sweep keeps deleting due records; the rest wait for the next sweep. */
export const PURGE_SWEEP_BUDGET_MS = 40_000;

/** Ids bound in one IN list, well under SQL Server's 2100 parameters. */
const ID_CHUNK = 500;

/** A JS Date bound as datetime2(3), so milliseconds survive (a bare Date binds as DATETIME). */
const at = (date: Date | null | undefined): unknown => (date ? new MssqlParameter(new Date(date), "datetime2", 3) : null);

const rowsOf = (result: any): any[] => (Array.isArray(result) ? result : []);

/**
 * The OUTPUT rows of a statement that starts with DELETE: TypeORM's SqlServerQueryRunner answers
 * those with [recordset, rowsAffected] instead of the recordset alone.
 */
const deletedRowsOf = (result: any): any[] =>
    Array.isArray(result) && result.length === 2 && typeof result[1] === "number" && (Array.isArray(result[0]) || result[0] === undefined)
        ? (result[0] ?? [])
        : rowsOf(result);

const dateOrNull = (value: unknown): Date | null => (value ? new Date(value as any) : null);

const DATA_REQUEST_COLUMNS = `Id, HiRequestId, TransactionId, ArtefactFk, HospitalId, DateFrom, DateTo, PushTokenHash, PrivateKey, Nonce,
    KeyExpiresAt, TransferDeadline, SessionStatus, PageCount, PagesReceived, CareContextStatus, NotifiedAt, NotifyRequestId,
    [Error], CreatedAt, CompletedAt`;

export const toDataRequestRow = (row: any): HiuDataRequestRow => ({
    id: Number(row.Id),
    hiRequestId: row.HiRequestId,
    transactionId: row.TransactionId ?? null,
    artefactFk: Number(row.ArtefactFk),
    hospitalId: Number(row.HospitalId),
    dateFrom: new Date(row.DateFrom),
    dateTo: new Date(row.DateTo),
    pushTokenHash: String(row.PushTokenHash ?? "").trim(),
    privateKey: row.PrivateKey ?? null,
    nonce: row.Nonce ?? null,
    keyExpiresAt: new Date(row.KeyExpiresAt),
    transferDeadline: dateOrNull(row.TransferDeadline),
    sessionStatus: row.SessionStatus as SessionStatus,
    pageCount: row.PageCount === null || row.PageCount === undefined ? null : Number(row.PageCount),
    pagesReceived: Number(row.PagesReceived) || 0,
    careContextStatus: row.CareContextStatus ?? null,
    notifiedAt: dateOrNull(row.NotifiedAt),
    notifyRequestId: row.NotifyRequestId ?? null,
    error: row.Error ?? null,
    createdAt: new Date(row.CreatedAt),
    completedAt: dateOrNull(row.CompletedAt),
});

export const toArtefact = (row: any): HiuDataArtefact => ({
    id: Number(row.Id),
    consentArtefactId: row.ConsentArtefactId,
    consentRequestId: row.ConsentRequestId ?? null,
    hospitalId: Number(row.HospitalId),
    hiuId: row.HiuId ?? null,
    hipId: row.HipId ?? null,
    status: row.Status,
    dateFrom: dateOrNull(row.DateFrom),
    dateTo: dateOrNull(row.DateTo),
    dataEraseAt: dateOrNull(row.DataEraseAt),
    fetchedAt: dateOrNull(row.FetchedAt),
    careContexts: row.CareContexts ?? null,
    recordsPurgedAt: dateOrNull(row.RecordsPurgedAt),
});

export const toRecordRow = (row: any): HiuRecordRow => ({
    id: Number(row.Id),
    dataRequestFk: Number(row.DataRequestFk),
    pageNumber: Number(row.PageNumber),
    entryIndex: Number(row.EntryIndex),
    careContextReference: row.CareContextReference ?? null,
    media: row.Media ?? null,
    checksumOk: row.ChecksumOk === true || row.ChecksumOk === 1,
    content: row.Content ?? null,
    receivedAt: new Date(row.ReceivedAt),
    deleteAt: dateOrNull(row.DeleteAt),
    contentOmitted: row.ContentOmitted === true || row.ContentOmitted === 1,
});

/** The columns updateDataRequest may write, and how each value is bound. */
const UPDATABLE: Record<keyof HiuDataRequestChanges, { column: string; bind: (value: any) => unknown }> = {
    transactionId: { column: "TransactionId", bind: (value) => value },
    privateKey: { column: "PrivateKey", bind: (value) => value },
    sessionStatus: { column: "SessionStatus", bind: (value) => value },
    careContextStatus: { column: "CareContextStatus", bind: (value) => value },
    error: { column: "[Error]", bind: (value) => (value === null ? null : String(value).slice(0, 500)) },
    completedAt: { column: "CompletedAt", bind: at },
};

/**
 * The one transfer whose records an artefact shows (@0 is the artefact): its latest RECEIVED transfer
 * holding entries, else its latest transfer holding entries. Records of earlier transfers (a FAILED
 * one asked again, or a repeat stored before repeats were refused) never show twice.
 */
const SHOWN_TRANSFER = `SELECT TOP 1 dr.Id FROM AbdmHiuDataRequests dr
                 WHERE dr.ArtefactFk = @0
                   AND EXISTS (SELECT 1 FROM AbdmHiuRecords x WHERE x.DataRequestFk = dr.Id AND x.EntryIndex >= 0)
                 ORDER BY CASE WHEN dr.SessionStatus = 'RECEIVED' THEN 0 ELSE 1 END, dr.Id DESC`;

/**
 * The artefact (@0) still GRANTED and not purged, checked in the same statement that reads content:
 * an artefact ends before its records are deleted, so a read that passed the service's check just
 * before a revocation committed still returns nothing.
 */
const STILL_READABLE = `EXISTS (SELECT 1 FROM AbdmHiuConsentArtefacts g WHERE g.Id = @0 AND g.Status = 'GRANTED' AND g.RecordsPurgedAt IS NULL)`;

/** Columns one record insert binds; 100 entries a page keeps a page well under SQL Server's 2100 parameters. */
const RECORD_COLUMNS = ["DataRequestFk", "ArtefactFk", "HospitalId", "PageNumber", "EntryIndex", "CareContextReference", "Media", "ChecksumOk", "Content", "DeleteAt", "ReceivedAt"];

export class HiuDataRepository implements HiuDataStore, HiuMaintenanceStore {
    private readonly query: HiuQuery;
    /** How every retried statement waits: the delays, the sleep and the jitter (retryTransient). */
    private readonly retry: Omit<RetryOptions, "label">;
    private readonly clock: () => number;
    /**
     * The large writes (a page's insert, a record's delete) of this process, one at a time: on a small
     * database (Azure SQL Basic) several multi-megabyte writes at once exhaust its log rate, and every
     * one of them runs past requestTimeout and is rolled back. Per process only: several instances on
     * one database each keep their own queue (their retries are spread by jitter).
     */
    private readonly largeWrites = new SerialQueue();

    constructor(options: { query?: HiuQuery; sleep?: (ms: number) => Promise<void>; retryDelaysMs?: readonly number[]; random?: () => number; clock?: () => number } = {}) {
        // The data source is loaded on first use, so importing this module (in a test) opens no database config.
        this.query = options.query ?? (async (sql, parameters) => {
            const { AppDataSource } = await import("../../config/database.js");
            return AppDataSource.query(sql, parameters as any[]);
        });
        this.retry = { delaysMs: options.retryDelaysMs ?? TRANSIENT_RETRY_DELAYS_MS, sleep: options.sleep, random: options.random };
        this.clock = options.clock ?? Date.now;
    }

    /**
     * Runs [work] (given its try number) in this process's queue of large writes, trying it again
     * after a transient error, which kept nothing (retryTransient). The queue is held while waiting to
     * try again: the database is what is busy. Never call largeWrite from inside one: it would wait on itself.
     */
    private largeWrite<T>(label: string, work: (attempt: number) => Promise<T>): Promise<T> {
        return this.largeWrites.run(() => retryTransient(work, { ...this.retry, label }));
    }

    // ---- Artefacts ----

    async findArtefact(artefactDbId: number): Promise<HiuDataArtefact | null> {
        const rows = rowsOf(await this.query(
            `SELECT a.Id, a.ConsentArtefactId, r.ConsentRequestId, r.HiuId, a.HospitalId, a.HipId, a.Status, a.DateFrom, a.DateTo,
                    a.DataEraseAt, a.FetchedAt, a.CareContexts, a.RecordsPurgedAt
             FROM AbdmHiuConsentArtefacts a
             LEFT JOIN AbdmHiuConsentRequests r ON r.Id = a.ConsentRequestFk
             WHERE a.Id = @0`,
            [artefactDbId],
        ));
        return rows[0] ? toArtefact(rows[0]) : null;
    }

    // ---- Data requests ----

    async findOpenDataRequest(artefactDbId: number): Promise<HiuDataRequestRow | null> {
        const rows = rowsOf(await this.query(
            `SELECT TOP 1 ${DATA_REQUEST_COLUMNS} FROM AbdmHiuDataRequests
             WHERE ArtefactFk = @0 AND SessionStatus IN ('REQUESTED', 'RECEIVING')
             ORDER BY Id DESC`,
            [artefactDbId],
        ));
        return rows[0] ? toDataRequestRow(rows[0]) : null;
    }

    async hasReceivedRecords(artefactDbId: number): Promise<boolean> {
        const rows = rowsOf(await this.query(
            `SELECT TOP 1 dr.Id FROM AbdmHiuDataRequests dr
             WHERE dr.ArtefactFk = @0 AND dr.SessionStatus = 'RECEIVED'
               AND EXISTS (SELECT 1 FROM AbdmHiuRecords rec WHERE rec.DataRequestFk = dr.Id AND rec.EntryIndex >= 0)`,
            [artefactDbId],
        ));
        return rows.length > 0;
    }

    async createDataRequest(row: NewHiuDataRequest): Promise<number> {
        try {
            const rows = rowsOf(await this.query(
                `INSERT INTO AbdmHiuDataRequests
                    (HiRequestId, ArtefactFk, HospitalId, DateFrom, DateTo, PushTokenHash, PrivateKey, Nonce, KeyExpiresAt, TransferDeadline, SessionStatus, PagesReceived, CreatedAt)
                 OUTPUT inserted.Id
                 VALUES (@0, @1, @2, @3, @4, @5, @6, @7, @8, @9, @10, 0, @11)`,
                [
                    row.hiRequestId, row.artefactFk, row.hospitalId, at(row.dateFrom), at(row.dateTo), row.pushTokenHash,
                    row.privateKey, row.nonce, at(row.keyExpiresAt), at(row.transferDeadline), row.sessionStatus, at(new Date()),
                ],
            ));
            return Number(rows[0]?.Id);
        } catch (error) {
            // UX_AbdmHiuDataRequests_OpenArtefact: another request opened a transfer for this artefact first.
            if (isDuplicateKeyError(error)) throw new HiuError("conflict", "Records are already being requested under this consent.");
            throw error;
        }
    }

    async failUnansweredRequest(id: number, input: { at: Date; error: string }): Promise<boolean> {
        const rows = rowsOf(await this.query(
            `UPDATE AbdmHiuDataRequests
             SET SessionStatus = 'FAILED', PrivateKey = NULL, CompletedAt = @1, [Error] = @2
             OUTPUT inserted.Id
             WHERE Id = @0 AND TransactionId IS NULL AND SessionStatus = 'REQUESTED' AND NotifiedAt IS NULL`,
            [id, at(input.at), input.error.slice(0, 500)],
        ));
        return rows.length === 1;
    }

    async reserveBytes(id: number, bytes: number, maxBytes: number): Promise<boolean> {
        const rows = rowsOf(await this.query(
            `UPDATE AbdmHiuDataRequests SET BytesReceived = BytesReceived + @1
             OUTPUT inserted.Id
             WHERE Id = @0 AND BytesReceived + @1 <= @2`,
            [id, bytes, maxBytes],
        ));
        return rows.length === 1;
    }

    async releaseBytes(id: number, bytes: number): Promise<void> {
        await this.query(
            `UPDATE AbdmHiuDataRequests SET BytesReceived = CASE WHEN BytesReceived > @1 THEN BytesReceived - @1 ELSE 0 END
             WHERE Id = @0`,
            [id, bytes],
        );
    }

    async updateDataRequest(id: number, changes: HiuDataRequestChanges): Promise<void> {
        const sets: string[] = [];
        const parameters: unknown[] = [id];
        for (const [key, value] of Object.entries(changes) as [keyof HiuDataRequestChanges, unknown][]) {
            const target = UPDATABLE[key];
            if (!target || value === undefined) continue;
            parameters.push(target.bind(value));
            sets.push(`${target.column} = @${parameters.length - 1}`);
        }
        if (sets.length === 0) return;
        await this.query(`UPDATE AbdmHiuDataRequests SET ${sets.join(", ")} WHERE Id = @0`, parameters);
    }

    async findDataRequest(id: number): Promise<HiuDataRequestRow | null> {
        const rows = rowsOf(await this.query(`SELECT ${DATA_REQUEST_COLUMNS} FROM AbdmHiuDataRequests WHERE Id = @0`, [id]));
        return rows[0] ? toDataRequestRow(rows[0]) : null;
    }

    async findDataRequestByHiRequestId(hiRequestId: string): Promise<HiuDataRequestRow | null> {
        const rows = rowsOf(await this.query(`SELECT ${DATA_REQUEST_COLUMNS} FROM AbdmHiuDataRequests WHERE HiRequestId = @0`, [hiRequestId]));
        return rows[0] ? toDataRequestRow(rows[0]) : null;
    }

    async findDataRequestByTokenHash(pushTokenHash: string): Promise<HiuDataRequestRow | null> {
        const rows = rowsOf(await this.query(`SELECT ${DATA_REQUEST_COLUMNS} FROM AbdmHiuDataRequests WHERE PushTokenHash = @0`, [pushTokenHash]));
        return rows[0] ? toDataRequestRow(rows[0]) : null;
    }

    async adoptTransactionId(id: number, transactionId: string): Promise<boolean> {
        try {
            const rows = rowsOf(await this.query(
                `UPDATE AbdmHiuDataRequests SET TransactionId = @1 OUTPUT inserted.Id
                 WHERE Id = @0 AND TransactionId IS NULL AND SessionStatus IN ('REQUESTED', 'RECEIVING') AND NotifiedAt IS NULL`,
                [id, transactionId.slice(0, 64)],
            ));
            return rows.length === 1;
        } catch (error) {
            // Another transfer already holds that transaction id (unique index).
            if (isDuplicateKeyError(error)) return false;
            throw error;
        }
    }

    async claimPageCount(id: number, pageCount: number): Promise<boolean> {
        const rows = rowsOf(await this.query(
            `UPDATE AbdmHiuDataRequests
             SET PageCount = @1, SessionStatus = CASE WHEN SessionStatus = 'REQUESTED' THEN 'RECEIVING' ELSE SessionStatus END
             OUTPUT inserted.Id
             WHERE Id = @0 AND (PageCount IS NULL OR PageCount = @1)
               AND SessionStatus IN ('REQUESTED', 'RECEIVING') AND NotifiedAt IS NULL`,
            [id, pageCount],
        ));
        return rows.length === 1;
    }

    async claimNotify(id: number, when: Date, notifyRequestId: string): Promise<boolean> {
        const rows = rowsOf(await this.query(
            `UPDATE AbdmHiuDataRequests SET NotifiedAt = @1, NotifyRequestId = @2
             OUTPUT inserted.Id
             WHERE Id = @0 AND NotifiedAt IS NULL`,
            [id, at(when), notifyRequestId],
        ));
        return rows.length === 1;
    }

    // ---- Records ----

    async hasPage(dataRequestId: number, pageNumber: number): Promise<boolean> {
        const rows = rowsOf(await this.query(
            `SELECT TOP 1 Id FROM AbdmHiuRecords WHERE DataRequestFk = @0 AND PageNumber = @1`,
            [dataRequestId, pageNumber],
        ));
        return rows.length > 0;
    }

    async addPage(input: { dataRequestId: number; artefactFk: number; hospitalId: number; pageNumber: number; records: NewHiuRecord[] }): Promise<{ duplicate: boolean; closed?: boolean; pagesReceived: number; afterRetry?: boolean }> {
        const parameters: unknown[] = [input.dataRequestId, input.artefactFk];
        const receivedAt = new Date();
        const values = input.records.map((record) => {
            const bound = [
                input.dataRequestId, input.artefactFk, input.hospitalId, input.pageNumber, record.entryIndex,
                record.careContextReference, record.media, record.checksumOk, record.content, at(record.deleteAt), at(receivedAt),
            ];
            const names = bound.map((value) => {
                parameters.push(value);
                return `@${parameters.length - 1}`;
            });
            return `(${names.join(", ")})`;
        });
        // One large write: queued behind the others and tried again after a timeout, which XACT_ABORT
        // rolled back whole. A try whose commit landed before its answer was lost meets the unique
        // index on the next try and is reported a duplicate with afterRetry (this call's own page).
        return this.largeWrite(`data push page ${input.pageNumber}`, async (attempt) => {
            try {
                // XACT_ABORT rolls the whole page back when one entry hits the unique index: a page is stored whole or not at all.
                // The page is kept only while the artefact is GRANTED and not purged, and the transfer is open,
                // checked inside the transaction after the insert: no lock on the artefact row is held while
                // megabytes are written, so a revocation (endArtefact) never waits on one for long. At the
                // check the artefact row is locked (UPDLOCK, HOLDLOCK) until COMMIT: a revocation, a lapse or
                // a timeout either commits first, and the page is dropped (THROW, rolled back), or waits for
                // this commit, and the page is then deleted with the rest (purgeArtefactRecords) or reported.
                // First a check that takes no lock (row versions, under read committed snapshot): a page
                // that waited in the queue while its artefact ended or its transfer closed is dropped
                // before megabytes are written and rolled back.
                const rows = rowsOf(await this.query(
                    `SET XACT_ABORT ON;
                     IF NOT EXISTS (SELECT 1 FROM AbdmHiuConsentArtefacts WHERE Id = @1 AND Status = 'GRANTED' AND RecordsPurgedAt IS NULL)
                        OR NOT EXISTS (SELECT 1 FROM AbdmHiuDataRequests WHERE Id = @0 AND NotifiedAt IS NULL AND SessionStatus IN ('REQUESTED', 'RECEIVING') AND PrivateKey IS NOT NULL)
                         THROW ${PAGE_CLOSED_ERROR}, 'The consent artefact or the transfer has ended.', 1;
                     BEGIN TRANSACTION;
                     INSERT INTO AbdmHiuRecords (${RECORD_COLUMNS.join(", ")}) VALUES ${values.join(", ")};
                     IF NOT EXISTS (SELECT 1 FROM AbdmHiuConsentArtefacts WITH (UPDLOCK, HOLDLOCK)
                                    WHERE Id = @1 AND Status = 'GRANTED' AND RecordsPurgedAt IS NULL)
                         THROW ${PAGE_CLOSED_ERROR}, 'The consent artefact is no longer granted.', 1;
                     UPDATE AbdmHiuDataRequests SET PagesReceived = PagesReceived + 1 OUTPUT inserted.PagesReceived
                     WHERE Id = @0 AND NotifiedAt IS NULL AND SessionStatus IN ('REQUESTED', 'RECEIVING') AND PrivateKey IS NOT NULL;
                     IF @@ROWCOUNT = 0
                         THROW ${PAGE_CLOSED_ERROR}, 'The transfer has ended.', 1;
                     COMMIT TRANSACTION;`,
                    parameters,
                ));
                return { duplicate: false, pagesReceived: Number(rows[0]?.PagesReceived) || 0 };
            } catch (error) {
                if (isDuplicateKeyError(error)) return { duplicate: true, pagesReceived: 0, afterRetry: attempt > 1 };
                if (isPageClosedError(error)) return { duplicate: false, closed: true, pagesReceived: 0 };
                throw error;
            }
        });
    }

    async listEntryOutcomes(dataRequestId: number): Promise<{ careContextReference: string | null; ok: boolean }[]> {
        const rows = rowsOf(await this.query(
            `SELECT CareContextReference, CAST(CASE WHEN ChecksumOk = 1 AND Content IS NOT NULL THEN 1 ELSE 0 END AS BIT) AS Ok
             FROM AbdmHiuRecords WHERE DataRequestFk = @0 AND EntryIndex >= 0
             ORDER BY PageNumber, EntryIndex`,
            [dataRequestId],
        ));
        return rows.map((row) => ({ careContextReference: row.CareContextReference ?? null, ok: row.Ok === true || row.Ok === 1 }));
    }

    async listRecords(artefactDbId: number, now: Date, maxContentBytes: number): Promise<HiuRecordRow[]> {
        // The running total of stored content decides which rows bring theirs: the database never
        // sends more than [maxContentBytes] of content in one answer.
        const rows = rowsOf(await this.query(
            `SELECT Id, DataRequestFk, PageNumber, EntryIndex, CareContextReference, Media, ChecksumOk, ReceivedAt, DeleteAt,
                    CASE WHEN Running <= @2 THEN Content ELSE NULL END AS Content,
                    CAST(CASE WHEN Content IS NOT NULL AND Running > @2 THEN 1 ELSE 0 END AS BIT) AS ContentOmitted
             FROM (
                 SELECT Id, DataRequestFk, PageNumber, EntryIndex, CareContextReference, Media, ChecksumOk, Content, ReceivedAt, DeleteAt,
                        SUM(CAST(ISNULL(DATALENGTH(Content), 0) AS BIGINT)) OVER (ORDER BY DataRequestFk, PageNumber, EntryIndex, Id ROWS UNBOUNDED PRECEDING) AS Running
                 FROM AbdmHiuRecords
                 WHERE ArtefactFk = @0 AND EntryIndex >= 0 AND (DeleteAt IS NULL OR DeleteAt > @1)
                   AND DataRequestFk = (${SHOWN_TRANSFER})
                   AND ${STILL_READABLE}
             ) r
             ORDER BY DataRequestFk, PageNumber, EntryIndex, Id`,
            [artefactDbId, at(now), maxContentBytes],
        ));
        return rows.map(toRecordRow);
    }

    async findRecord(artefactDbId: number, recordId: number, now: Date): Promise<HiuRecordRow | null> {
        const rows = rowsOf(await this.query(
            `SELECT Id, DataRequestFk, PageNumber, EntryIndex, CareContextReference, Media, ChecksumOk, Content, ReceivedAt, DeleteAt
             FROM AbdmHiuRecords
             WHERE Id = @0 AND ArtefactFk = @1 AND EntryIndex >= 0 AND (DeleteAt IS NULL OR DeleteAt > @2)
               AND DataRequestFk = (${SHOWN_TRANSFER.replace(/@0/g, "@1")})
               AND ${STILL_READABLE.replace(/@0/g, "@1")}`,
            [recordId, artefactDbId, at(now)],
        ));
        return rows[0] ? toRecordRow(rows[0]) : null;
    }

    // ---- Purging ----

    /**
     * Deletes the stored records of an artefact that is no longer GRANTED, one row per statement (each
     * a large write), then sets RecordsPurgedAt once none is left. Returns how many it deleted. A
     * GRANTED artefact's records are never touched. When a delete still fails after its tries it
     * throws a RecordPurgeError carrying the count so far; the sweep (purgeRecords) deletes the rest.
     */
    async purgeArtefactRecords(artefactFk: number, when: Date): Promise<number> {
        let deleted = 0;
        for (;;) {
            let rows: any[];
            try {
                rows = deletedRowsOf(await this.largeWrite("record delete", () => this.query(
                    `DELETE TOP (1) rec
                     OUTPUT deleted.Id
                     FROM AbdmHiuRecords rec
                     INNER JOIN AbdmHiuConsentArtefacts a ON a.Id = rec.ArtefactFk
                     WHERE rec.ArtefactFk = @0 AND a.Status <> 'GRANTED'`,
                    [artefactFk],
                )));
            } catch (error) {
                throw new RecordPurgeError(deleted, error);
            }
            if (rows.length === 0) break;
            deleted += rows.length;
        }
        try {
            // Safe to repeat: it changes nothing once stamped, or while a record is left.
            await retryTransient(() => this.query(
                `UPDATE AbdmHiuConsentArtefacts SET RecordsPurgedAt = @1
                 WHERE Id = @0 AND Status <> 'GRANTED' AND RecordsPurgedAt IS NULL
                   AND NOT EXISTS (SELECT 1 FROM AbdmHiuRecords WHERE ArtefactFk = @0)`,
                [artefactFk, at(when)],
            ), { ...this.retry, label: "purge stamp" });
        } catch (error) {
            // Every record went; only the stamp failed, and the sweep's stamp sets it later.
            throw new RecordPurgeError(deleted, error);
        }
        return deleted;
    }

    // ---- Maintenance ----

    async purgeRecords(now: Date): Promise<{ artefactFk: number; hospitalId: number; consentArtefactId: string | null; count: number }[]> {
        // Due: past DeleteAt, or the artefact is past its dataEraseAt or no longer GRANTED (revoked, lapsed).
        // One row per statement, for at most PURGE_SWEEP_BUDGET_MS: the rest wait for the next sweep.
        // A delete that still fails stops this sweep's deleting; what it deleted is still stamped and reported.
        const started = this.clock();
        const purged = new Map<number, { hospitalId: number; count: number }>();
        while (this.clock() - started < PURGE_SWEEP_BUDGET_MS) {
            let rows: any[];
            try {
                rows = deletedRowsOf(await this.largeWrite("record delete", () => this.query(
                    `DELETE TOP (1) rec
                     OUTPUT deleted.ArtefactFk, deleted.HospitalId
                     FROM AbdmHiuRecords rec
                     INNER JOIN AbdmHiuConsentArtefacts a ON a.Id = rec.ArtefactFk
                     WHERE rec.DeleteAt <= @0 OR a.DataEraseAt <= @0 OR a.Status <> 'GRANTED'`,
                    [at(now)],
                )));
            } catch (error) {
                console.error(`[ABDM HIU] maintenance: a record delete failed (${errorCodeOf(error)}); the next sweep goes on`);
                break;
            }
            if (rows.length === 0) break;
            for (const row of rows) {
                const artefactFk = Number(row.ArtefactFk);
                if (!Number.isInteger(artefactFk)) continue;
                const entry = purged.get(artefactFk) ?? { hospitalId: Number(row.HospitalId), count: 0 };
                entry.count += 1;
                purged.set(artefactFk, entry);
            }
        }

        // Stamped once none is left, whether this sweep or an artefact's own purge (one interrupted
        // before its stamp) deleted the last: every ended artefact, and every one past its dataEraseAt.
        // Neither this nor the names below may lose the counts: a failure is logged and the counts
        // are still returned (the next sweep stamps).
        const retry = this.retry;
        try {
            await retryTransient(() => this.query(
                `UPDATE a SET RecordsPurgedAt = @0
                 FROM AbdmHiuConsentArtefacts a
                 WHERE a.RecordsPurgedAt IS NULL AND (a.Status <> 'GRANTED' OR a.DataEraseAt <= @0)
                   AND NOT EXISTS (SELECT 1 FROM AbdmHiuRecords r WHERE r.ArtefactFk = a.Id)`,
                [at(now)],
            ), { ...retry, label: "purge stamp" });
        } catch (error) {
            console.error(`[ABDM HIU] maintenance: the purge stamp failed (${errorCodeOf(error)}); the next sweep sets it`);
        }
        const ids = [...purged.keys()];
        const names = new Map<number, string | null>();
        for (let start = 0; start < ids.length; start += ID_CHUNK) {
            const chunk = ids.slice(start, start + ID_CHUNK);
            try {
                const rows = rowsOf(await retryTransient(() => this.query(
                    `SELECT Id, ConsentArtefactId FROM AbdmHiuConsentArtefacts WHERE Id IN (${chunk.map((_, index) => `@${index}`).join(", ")})`,
                    chunk,
                ), { ...retry, label: "purge names" }));
                for (const row of rows) names.set(Number(row.Id), row.ConsentArtefactId ?? null);
            } catch (error) {
                console.error(`[ABDM HIU] maintenance: artefact ids for the purge audit could not be read (${errorCodeOf(error)})`);
            }
        }
        return ids.map((artefactFk) => ({
            artefactFk,
            hospitalId: purged.get(artefactFk)!.hospitalId,
            consentArtefactId: names.get(artefactFk) ?? null,
            count: purged.get(artefactFk)!.count,
        }));
    }

    async clearPrivateKeys(now: Date): Promise<number> {
        const rows = rowsOf(await this.query(
            `UPDATE AbdmHiuDataRequests SET PrivateKey = NULL
             OUTPUT inserted.Id
             WHERE PrivateKey IS NOT NULL AND (KeyExpiresAt <= @0 OR SessionStatus IN ('RECEIVED', 'FAILED'))`,
            [at(now)],
        ));
        return rows.length;
    }

    async listTimedOutTransfers(now: Date, limit: number): Promise<number[]> {
        const rows = rowsOf(await this.query(
            `SELECT TOP (@1) Id FROM AbdmHiuDataRequests
             WHERE NotifiedAt IS NULL AND SessionStatus IN ('REQUESTED', 'RECEIVING') AND TransferDeadline <= @0
             ORDER BY TransferDeadline`,
            [at(now), limit],
        ));
        return rows.map((row) => Number(row.Id));
    }

    async closeStaleClaimed(now: Date): Promise<number> {
        const rows = rowsOf(await this.query(
            `UPDATE AbdmHiuDataRequests
             SET SessionStatus = 'FAILED', PrivateKey = NULL, CompletedAt = @0,
                 [Error] = COALESCE([Error], 'The transfer was not settled before its window closed.')
             OUTPUT inserted.Id
             WHERE NotifiedAt IS NOT NULL AND SessionStatus IN ('REQUESTED', 'RECEIVING') AND TransferDeadline <= @0`,
            [at(now)],
        ));
        return rows.length;
    }
}

export const hiuDataRepository = new HiuDataRepository();
