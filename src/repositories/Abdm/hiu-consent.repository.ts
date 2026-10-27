import { In, IsNull, MssqlParameter } from "typeorm/index.js";
import { AppDataSource } from "../../config/database.js";
import { HiuError } from "../../services/Abdm/hiu/hiu-enums.js";
import { HiuConsentRequest } from "../../models/Abdm/hiu-consent-request.model.js";
import { HiuConsentArtefact } from "../../models/Abdm/hiu-consent-artefact.model.js";
import { HiuDataRequest } from "../../models/Abdm/hiu-data-request.model.js";
import { HiuRecord } from "../../models/Abdm/hiu-record.model.js";
import { User } from "../../models/Account/user.model.js";
import type { ArtefactStatus } from "../../services/Abdm/hiu/hiu-enums.js";
import { ARTEFACT_RECORD_COUNT, findPatientIn, jsonList, SELECT_REQUEST, toRequestRow } from "./hiu-consent.sql.js";
import type {
    ArtefactRow,
    ArtefactWithTransfer,
    ConsentRequestChanges,
    ConsentRequestRow,
    FetchedDetail,
    HiuConsentStore,
    NewConsentRequestRow,
    TransferRow,
} from "../../services/Abdm/hiu/hiu-consent.service.js";

/** SQL Server duplicate key errors (unique constraint, unique index). */
const isDuplicateKey = (error: any): boolean => {
    const number = error?.number ?? error?.originalError?.info?.number ?? error?.driverError?.number;
    return number === 2627 || number === 2601;
};

/** A JS Date bound as datetime2(3) in raw SQL (a bare Date binds as DATETIME). */
const at = (date: Date): MssqlParameter => new MssqlParameter(new Date(date), "datetime2", 3);

/** How long a raise waits for another raise of the same need to finish its check and insert. */
const OPEN_REQUEST_LOCK_TIMEOUT_MS = 15_000;

const toArtefactRow = (raw: any): ArtefactRow => ({
    id: Number(raw.Id),
    consentArtefactId: raw.ConsentArtefactId,
    consentRequestFk: Number(raw.ConsentRequestFk),
    hospitalId: Number(raw.HospitalId),
    hipId: raw.HipId ?? null,
    hipName: raw.HipName ?? null,
    status: raw.Status as ArtefactStatus,
    statusAt: raw.StatusAt,
    hiTypes: raw.HiTypes ? jsonList(raw.HiTypes) : null,
    dateFrom: raw.DateFrom ?? null,
    dateTo: raw.DateTo ?? null,
    dataEraseAt: raw.DataEraseAt ?? null,
    accessMode: raw.AccessMode ?? null,
    fetchRequestId: raw.FetchRequestId ?? null,
    fetchedAt: raw.FetchedAt ?? null,
    recordsPurgedAt: raw.RecordsPurgedAt ?? null,
});

const toRequestColumns = (changes: ConsentRequestChanges): Partial<HiuConsentRequest> => {
    const columns: Partial<HiuConsentRequest> = {};
    if (changes.consentRequestId !== undefined) columns.ConsentRequestId = changes.consentRequestId;
    if (changes.statusRequestId !== undefined) columns.StatusRequestId = changes.statusRequestId;
    if (changes.status !== undefined) columns.Status = changes.status;
    if (changes.statusAt !== undefined) columns.StatusAt = changes.statusAt;
    if (changes.abdmErrorCode !== undefined) columns.AbdmErrorCode = changes.abdmErrorCode ? changes.abdmErrorCode.slice(0, 20) : null;
    if (changes.abdmError !== undefined) columns.AbdmError = changes.abdmError ? changes.abdmError.slice(0, 500) : null;
    return columns;
};

/**
 * The consent side of the HIU: AbdmHiuConsentRequests and AbdmHiuConsentArtefacts, the latest
 * transfer and record count per artefact for the staff view, and the purge of a revoked or lapsed
 * artefact's records. Every staff read is filtered by hospital.
 */
export class HiuConsentRepository implements HiuConsentStore {
    private get requests() {
        return AppDataSource.getRepository(HiuConsentRequest);
    }

    private get artefacts() {
        return AppDataSource.getRepository(HiuConsentArtefact);
    }

    findPatient(userId: string, hospitalId: number): Promise<{ userId: string; name: string; abhaAddress: string | null; abhaNumber: string | null } | null> {
        return findPatientIn((sql, parameters) => AppDataSource.query(sql, parameters as any[]), userId, hospitalId);
    }

    async staffName(userId: string): Promise<string | null> {
        const user = await AppDataSource.getRepository(User).findOne({ where: { Id: userId }, select: { Id: true, FirstName: true, LastName: true } });
        const name = `${user?.FirstName || ""} ${user?.LastName || ""}`.trim();
        return name ? name.slice(0, 200) : null;
    }

    async findOpenRequests(input: { hospitalId: number; patientUserId: string; purposeCode: string }): Promise<ConsentRequestRow[]> {
        const rows = await AppDataSource.query(
            `${SELECT_REQUEST}
             WHERE r.HospitalId = @0 AND r.PatientUserId = @1 AND r.PurposeCode = @2 AND r.Status IN ('SENDING', 'REQUESTED')`,
            [input.hospitalId, input.patientUserId, input.purposeCode],
        );
        return (rows as any[]).map(toRequestRow);
    }

    /**
     * sp_getapplock on hospital, patient and purpose, owned by a transaction on a connection of its
     * own: the lock holds across instances until [work] (on pooled connections, autocommit) is done,
     * and ends with the rollback of that otherwise empty transaction.
     */
    async withOpenRequestLock<T>(key: { hospitalId: number; patientUserId: string; purposeCode: string }, work: () => Promise<T>): Promise<T> {
        const resource = `AbdmHiuOpenRequest:${key.hospitalId}:${key.patientUserId.toLowerCase()}:${key.purposeCode}`.slice(0, 255);
        const runner = AppDataSource.createQueryRunner();
        await runner.connect();
        try {
            await runner.startTransaction();
            const result = await runner.query(
                `DECLARE @result INT;
                 EXEC @result = sp_getapplock @Resource = @0, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = @1;
                 SELECT @result AS Result;`,
                [resource, OPEN_REQUEST_LOCK_TIMEOUT_MS],
            );
            if (!(Number(result?.[0]?.Result) >= 0)) {
                throw new HiuError("conflict", "Another record request for this patient is being raised right now. Try again in a moment.");
            }
            return await work();
        } finally {
            if (runner.isTransactionActive) await runner.rollbackTransaction().catch(() => undefined);
            await runner.release();
        }
    }

    async createRequest(row: NewConsentRequestRow): Promise<number> {
        const saved = await this.requests.save(this.requests.create({
            InitRequestId: row.initRequestId,
            HospitalId: row.hospitalId,
            HiuId: row.hiuId,
            OrganizationId: row.organizationId,
            StaffUserId: row.staffUserId,
            StaffName: row.staffName ? row.staffName.slice(0, 200) : null,
            PatientUserId: row.patientUserId,
            AbhaAddress: row.abhaAddress,
            PurposeCode: row.purposeCode,
            HiTypes: JSON.stringify(row.hiTypes),
            DateFrom: row.dateFrom,
            DateTo: row.dateTo,
            DataEraseAt: row.dataEraseAt,
            AccessMode: row.accessMode,
            Status: row.status,
            StatusAt: row.statusAt,
            CreatedAt: row.statusAt,
        }));
        return saved.Id;
    }

    async updateRequest(id: number, changes: ConsentRequestChanges): Promise<void> {
        const columns = toRequestColumns(changes);
        if (Object.keys(columns).length === 0) return;
        await this.requests.update(id, { ...columns, UpdatedAt: new Date() });
    }

    async updateSendingRequest(id: number, changes: ConsentRequestChanges): Promise<boolean> {
        const columns = toRequestColumns(changes);
        if (Object.keys(columns).length === 0) return false;
        const result = await this.requests.createQueryBuilder()
            .update(HiuConsentRequest)
            .set({ ...columns, UpdatedAt: new Date() })
            .where("Id = :id AND Status = 'SENDING' AND ConsentRequestId IS NULL", { id })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    async failStaleSending(input: { createdBefore: Date; at: Date; message: string }): Promise<{ id: number; hospitalId: number; initRequestId: string }[]> {
        const rows = await AppDataSource.query(
            `UPDATE AbdmHiuConsentRequests
             SET Status = 'FAILED', StatusAt = @1, AbdmErrorCode = NULL, AbdmError = @2, UpdatedAt = @1
             OUTPUT inserted.Id, inserted.HospitalId, inserted.InitRequestId
             WHERE Status = 'SENDING' AND ConsentRequestId IS NULL AND CreatedAt <= @0`,
            [at(input.createdBefore), at(input.at), input.message.slice(0, 500)],
        );
        return (Array.isArray(rows) ? rows : []).map((row: any) => ({ id: Number(row.Id), hospitalId: Number(row.HospitalId), initRequestId: row.InitRequestId }));
    }

    private async oneRequest(where: string, params: unknown[]): Promise<ConsentRequestRow | null> {
        const rows = await AppDataSource.query(`${SELECT_REQUEST} WHERE ${where}`, params);
        return Array.isArray(rows) && rows[0] ? toRequestRow(rows[0]) : null;
    }

    findRequest(hospitalId: number, id: number): Promise<ConsentRequestRow | null> {
        return this.oneRequest("r.Id = @0 AND r.HospitalId = @1", [id, hospitalId]);
    }

    findRequestById(id: number): Promise<ConsentRequestRow | null> {
        return this.oneRequest("r.Id = @0", [id]);
    }

    findRequestByInitRequestId(requestId: string): Promise<ConsentRequestRow | null> {
        return this.oneRequest("r.InitRequestId = @0", [requestId]);
    }

    findRequestByStatusRequestId(requestId: string): Promise<ConsentRequestRow | null> {
        return this.oneRequest("r.StatusRequestId = @0", [requestId]);
    }

    findRequestByConsentRequestId(consentRequestId: string): Promise<ConsentRequestRow | null> {
        return this.oneRequest("r.ConsentRequestId = @0", [consentRequestId]);
    }

    async listRequests(input: { hospitalId: number; page: number; pageSize: number; status?: string }): Promise<{ rows: ConsentRequestRow[]; total: number }> {
        const filter = input.status ? "r.HospitalId = @0 AND r.Status = @1" : "r.HospitalId = @0";
        const params: unknown[] = input.status ? [input.hospitalId, input.status] : [input.hospitalId];
        const offset = (input.page - 1) * input.pageSize;
        const rows = await AppDataSource.query(
            `${SELECT_REQUEST}
             WHERE ${filter}
             ORDER BY r.CreatedAt DESC, r.Id DESC
             OFFSET @${params.length} ROWS FETCH NEXT @${params.length + 1} ROWS ONLY`,
            [...params, offset, input.pageSize],
        );
        const count = await AppDataSource.query(`SELECT COUNT(1) AS Total FROM AbdmHiuConsentRequests r WHERE ${filter}`, params);
        return { rows: (rows as any[]).map(toRequestRow), total: Number(count?.[0]?.Total ?? 0) };
    }

    async listArtefacts(consentRequestFk: number): Promise<ArtefactWithTransfer[]> {
        const rows = await AppDataSource.query(
            `SELECT a.*,
                    d.Id AS DrId, d.TransactionId AS DrTransactionId, d.SessionStatus AS DrSessionStatus,
                    d.PageCount AS DrPageCount, d.PagesReceived AS DrPagesReceived, d.Error AS DrError,
                    d.CreatedAt AS DrCreatedAt, d.CompletedAt AS DrCompletedAt,
                    ${ARTEFACT_RECORD_COUNT} AS RecordCount
             FROM AbdmHiuConsentArtefacts a
             OUTER APPLY (
                 SELECT TOP 1 dr.Id, dr.TransactionId, dr.SessionStatus, dr.PageCount, dr.PagesReceived, dr.Error, dr.CreatedAt, dr.CompletedAt
                 FROM AbdmHiuDataRequests dr
                 WHERE dr.ArtefactFk = a.Id
                 ORDER BY dr.CreatedAt DESC, dr.Id DESC
             ) d
             WHERE a.ConsentRequestFk = @0
             ORDER BY a.Id`,
            [consentRequestFk],
        );
        return (rows as any[]).map((raw) => {
            const transfer: TransferRow | null = raw.DrId == null ? null : {
                transactionId: raw.DrTransactionId ?? null,
                sessionStatus: raw.DrSessionStatus,
                pageCount: raw.DrPageCount ?? null,
                pagesReceived: Number(raw.DrPagesReceived ?? 0),
                error: raw.DrError ?? null,
                requestedAt: raw.DrCreatedAt ?? null,
                completedAt: raw.DrCompletedAt ?? null,
            };
            return { ...toArtefactRow(raw), transfer, recordCount: Number(raw.RecordCount ?? 0) };
        });
    }

    async findArtefactsByConsentArtefactIds(ids: string[]): Promise<ArtefactRow[]> {
        if (ids.length === 0) return [];
        const rows = await this.artefacts.find({ where: { ConsentArtefactId: In(ids) } });
        return rows.map(toArtefactRow);
    }

    async findArtefactByFetchRequestId(requestId: string): Promise<ArtefactRow | null> {
        const row = await this.artefacts.findOne({ where: { FetchRequestId: requestId } });
        return row ? toArtefactRow(row) : null;
    }

    async addArtefacts(input: { consentRequestFk: number; hospitalId: number; consentArtefactIds: string[]; at: Date; status?: "GRANTED" | "REVOKED" | "EXPIRED" }): Promise<void> {
        if (input.consentArtefactIds.length === 0) return;
        const status = input.status ?? "GRANTED";
        const existing = new Set((await this.artefacts.find({
            where: { ConsentArtefactId: In(input.consentArtefactIds) },
            select: { Id: true, ConsentArtefactId: true },
        })).map((row) => row.ConsentArtefactId));
        for (const consentArtefactId of input.consentArtefactIds) {
            if (existing.has(consentArtefactId)) continue;
            try {
                await this.artefacts.insert({
                    ConsentArtefactId: consentArtefactId,
                    ConsentRequestFk: input.consentRequestFk,
                    HospitalId: input.hospitalId,
                    Status: status,
                    StatusAt: input.at,
                    // An artefact stored already ended has nothing to receive, and nothing to delete.
                    ...(status === "GRANTED" ? {} : { RecordsPurgedAt: input.at }),
                    CreatedAt: input.at,
                });
            } catch (error) {
                // A concurrent repeat of the same notification stored it first (unique ConsentArtefactId).
                if (!isDuplicateKey(error)) throw error;
            }
        }
    }

    async claimFetch(artefactId: number, requestId: string, at: Date): Promise<boolean> {
        const result = await this.artefacts.createQueryBuilder()
            .update(HiuConsentArtefact)
            .set({ FetchRequestId: requestId, FetchAttempts: () => "FetchAttempts + 1", UpdatedAt: at })
            .where("Id = :artefactId AND FetchRequestId IS NULL AND FetchedAt IS NULL AND Status = 'GRANTED'", { artefactId })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    async releaseFetch(artefactId: number, requestId: string): Promise<void> {
        await this.artefacts.update({ Id: artefactId, FetchRequestId: requestId }, { FetchRequestId: null, UpdatedAt: new Date() });
    }

    async listFetchRetries(input: { staleBefore: Date; maxAttempts: number; limit: number }): Promise<ArtefactRow[]> {
        const rows = await AppDataSource.query(
            `SELECT TOP (@2) a.* FROM AbdmHiuConsentArtefacts a
             WHERE a.Status = 'GRANTED' AND a.FetchedAt IS NULL AND a.RecordsPurgedAt IS NULL
               AND a.FetchAttempts < @1 AND COALESCE(a.UpdatedAt, a.CreatedAt) <= @0
             ORDER BY COALESCE(a.UpdatedAt, a.CreatedAt), a.Id`,
            [at(input.staleBefore), input.maxAttempts, input.limit],
        );
        return (Array.isArray(rows) ? rows : []).map(toArtefactRow);
    }

    async reclaimFetch(input: { artefactId: number; previousRequestId: string | null; requestId: string; at: Date; staleBefore: Date; maxAttempts: number }): Promise<boolean> {
        const rows = await AppDataSource.query(
            `UPDATE AbdmHiuConsentArtefacts
             SET FetchRequestId = @1, FetchAttempts = FetchAttempts + 1, UpdatedAt = @3
             OUTPUT inserted.Id
             WHERE Id = @0 AND Status = 'GRANTED' AND FetchedAt IS NULL AND RecordsPurgedAt IS NULL
               AND FetchAttempts < @5 AND COALESCE(UpdatedAt, CreatedAt) <= @4
               AND ((@2 IS NULL AND FetchRequestId IS NULL) OR FetchRequestId = @2)`,
            [input.artefactId, input.requestId, input.previousRequestId, at(input.at), at(input.staleBefore), input.maxAttempts],
        );
        return Array.isArray(rows) && rows.length === 1;
    }

    async saveFetchedDetail(artefactId: number, detail: FetchedDetail): Promise<boolean> {
        const result = await this.artefacts.createQueryBuilder()
            .update(HiuConsentArtefact)
            .set({
                HipId: detail.hipId,
                HipName: detail.hipName,
                HiTypes: JSON.stringify(detail.hiTypes).slice(0, 400),
                DateFrom: detail.dateFrom,
                DateTo: detail.dateTo,
                DataEraseAt: detail.dataEraseAt,
                AccessMode: detail.accessMode,
                Frequency: detail.frequency,
                CareContexts: detail.careContexts,
                Signature: detail.signature,
                FetchedAt: detail.fetchedAt,
                UpdatedAt: detail.fetchedAt,
            })
            // Only while GRANTED: an on-fetch landing after a revocation writes nothing back onto it.
            .where("Id = :artefactId AND FetchedAt IS NULL AND Status = 'GRANTED'", { artefactId })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    async endArtefact(artefactId: number, status: "REVOKED" | "EXPIRED" | "DENIED", at: Date): Promise<number> {
        return AppDataSource.transaction(async (manager) => {
            // The artefact row first: its lock is what a page being stored (addPage) checks under, so
            // the two serialise and no page lands after the records are deleted.
            await manager.getRepository(HiuConsentArtefact).update(artefactId, { Status: status, StatusAt: at, CareContexts: null, UpdatedAt: at });
            const deleted = await manager.getRepository(HiuRecord).delete({ ArtefactFk: artefactId });
            await manager.getRepository(HiuDataRequest).update({ ArtefactFk: artefactId }, { PrivateKey: null });
            await manager.getRepository(HiuConsentArtefact).update(
                { Id: artefactId, RecordsPurgedAt: IsNull() },
                { RecordsPurgedAt: at },
            );
            return deleted.affected ?? 0;
        });
    }

    async listEvents(input: { hospitalId: number; consentRequestId: string | null; requestIds: string[]; artefactIds: string[] }): Promise<{ at: Date; event: string; outcome: string }[]> {
        const params: unknown[] = [input.hospitalId];
        const place = (value: unknown): string => {
            params.push(value);
            return `@${params.length - 1}`;
        };
        const matches: string[] = [];
        if (input.consentRequestId) matches.push(`e.ConsentRequestId = ${place(input.consentRequestId)}`);
        if (input.requestIds.length > 0) matches.push(`e.RequestId IN (${input.requestIds.map(place).join(", ")})`);
        // Artefact ids are capped so the parameter list stays small.
        const artefactIds = input.artefactIds.slice(0, 200);
        if (artefactIds.length > 0) matches.push(`e.ArtefactId IN (${artefactIds.map(place).join(", ")})`);
        if (matches.length === 0) return [];
        const rows = await AppDataSource.query(
            `SELECT TOP 500 e.At, e.Event, e.Outcome
             FROM AbdmHiuAuditEvents e
             WHERE e.HospitalId = @0 AND (${matches.join(" OR ")})
             ORDER BY e.At, e.Id`,
            params,
        );
        return (rows as any[]).map((row) => ({ at: row.At, event: row.Event, outcome: row.Outcome }));
    }
}

export const hiuConsentRepository = new HiuConsentRepository();
