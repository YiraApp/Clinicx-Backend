import { MssqlParameter } from "typeorm/index.js";
import { HiuError, type SessionStatus } from "../../services/Abdm/hiu/hiu-enums.js";
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

const sqlErrorNumber = (error: any): number =>
    Number(error?.number ?? error?.driverError?.number ?? error?.originalError?.info?.number ?? error?.driverError?.originalError?.info?.number);

export const isDuplicateKeyError = (error: any): boolean => DUPLICATE_KEY_ERRORS.has(sqlErrorNumber(error));

/** Raised by addPage's own THROW when the artefact or the transfer closed before the page was stored. */
export const PAGE_CLOSED_ERROR = 50_001;
const isPageClosedError = (error: any): boolean => sqlErrorNumber(error) === PAGE_CLOSED_ERROR;

/** A JS Date bound as datetime2(3), so milliseconds survive (a bare Date binds as DATETIME). */
const at = (date: Date | null | undefined): unknown => (date ? new MssqlParameter(new Date(date), "datetime2", 3) : null);

const rowsOf = (result: any): any[] => (Array.isArray(result) ? result : []);

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

/** Columns one record insert binds; 100 entries a page keeps a page well under SQL Server's 2100 parameters. */
const RECORD_COLUMNS = ["DataRequestFk", "ArtefactFk", "HospitalId", "PageNumber", "EntryIndex", "CareContextReference", "Media", "ChecksumOk", "Content", "DeleteAt", "ReceivedAt"];

export class HiuDataRepository implements HiuDataStore, HiuMaintenanceStore {
    private readonly query: HiuQuery;

    constructor(options: { query?: HiuQuery } = {}) {
        // The data source is loaded on first use, so importing this module (in a test) opens no database config.
        this.query = options.query ?? (async (sql, parameters) => {
            const { AppDataSource } = await import("../../config/database.js");
            return AppDataSource.query(sql, parameters as any[]);
        });
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

    async addPage(input: { dataRequestId: number; artefactFk: number; hospitalId: number; pageNumber: number; records: NewHiuRecord[] }): Promise<{ duplicate: boolean; closed?: boolean; pagesReceived: number }> {
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
        try {
            // XACT_ABORT rolls the whole page back when one entry hits the unique index: a page is stored whole or not at all.
            // The page is stored only while the artefact is GRANTED and not purged, and the transfer is open,
            // checked inside the transaction: the artefact row is locked first (endArtefact takes the same
            // row first), so a revocation, a lapse or a timeout either waits for this page, and then deletes
            // or reports it, or wins, and the page is dropped (THROW, rolled back).
            const rows = rowsOf(await this.query(
                `SET XACT_ABORT ON;
                 BEGIN TRANSACTION;
                 IF NOT EXISTS (SELECT 1 FROM AbdmHiuConsentArtefacts WITH (UPDLOCK, HOLDLOCK)
                                WHERE Id = @1 AND Status = 'GRANTED' AND RecordsPurgedAt IS NULL)
                     THROW ${PAGE_CLOSED_ERROR}, 'The consent artefact is no longer granted.', 1;
                 UPDATE AbdmHiuDataRequests SET PagesReceived = PagesReceived + 1 OUTPUT inserted.PagesReceived
                 WHERE Id = @0 AND NotifiedAt IS NULL AND SessionStatus IN ('REQUESTED', 'RECEIVING') AND PrivateKey IS NOT NULL;
                 IF @@ROWCOUNT = 0
                     THROW ${PAGE_CLOSED_ERROR}, 'The transfer has ended.', 1;
                 INSERT INTO AbdmHiuRecords (${RECORD_COLUMNS.join(", ")}) VALUES ${values.join(", ")};
                 COMMIT TRANSACTION;`,
                parameters,
            ));
            return { duplicate: false, pagesReceived: Number(rows[0]?.PagesReceived) || 0 };
        } catch (error) {
            if (isDuplicateKeyError(error)) return { duplicate: true, pagesReceived: 0 };
            if (isPageClosedError(error)) return { duplicate: false, closed: true, pagesReceived: 0 };
            throw error;
        }
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
               AND DataRequestFk = (${SHOWN_TRANSFER.replace(/@0/g, "@1")})`,
            [recordId, artefactDbId, at(now)],
        ));
        return rows[0] ? toRecordRow(rows[0]) : null;
    }

    // ---- Maintenance ----

    async purgeRecords(now: Date): Promise<{ artefactFk: number; hospitalId: number; consentArtefactId: string | null; count: number }[]> {
        // Due: past DeleteAt, or the artefact is past its dataEraseAt or no longer GRANTED (revoked, lapsed).
        const rows = rowsOf(await this.query(
            `SET XACT_ABORT ON;
             DECLARE @purged TABLE (ArtefactFk INT, HospitalId INT);
             DELETE rec
             OUTPUT deleted.ArtefactFk, deleted.HospitalId INTO @purged
             FROM AbdmHiuRecords rec
             INNER JOIN AbdmHiuConsentArtefacts a ON a.Id = rec.ArtefactFk
             WHERE rec.DeleteAt <= @0 OR a.DataEraseAt <= @0 OR a.Status <> 'GRANTED';
             UPDATE a SET RecordsPurgedAt = @0
             FROM AbdmHiuConsentArtefacts a
             WHERE a.Id IN (SELECT ArtefactFk FROM @purged) AND a.RecordsPurgedAt IS NULL;
             SELECT p.ArtefactFk, p.HospitalId, a.ConsentArtefactId, COUNT(*) AS Purged
             FROM @purged p LEFT JOIN AbdmHiuConsentArtefacts a ON a.Id = p.ArtefactFk
             GROUP BY p.ArtefactFk, p.HospitalId, a.ConsentArtefactId;`,
            [at(now)],
        ));
        return rows.map((row) => ({
            artefactFk: Number(row.ArtefactFk),
            hospitalId: Number(row.HospitalId),
            consentArtefactId: row.ConsentArtefactId ?? null,
            count: Number(row.Purged) || 0,
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
