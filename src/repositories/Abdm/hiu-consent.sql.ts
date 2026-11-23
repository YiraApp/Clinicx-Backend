import type { StoredConsentStatus } from "../../services/Abdm/hiu/hiu-enums.js";
import type { ConsentRequestRow, TransferRow } from "../../services/Abdm/hiu/hiu-consent.service.js";
import { readPushRefusalDetail, type PushRefusal } from "../../services/Abdm/hiu/hiu-audit.js";

/**
 * The consent repository's raw SQL and row mapping, kept apart from the repository so tests can read
 * them without loading the database configuration.
 */

export type HiuConsentQuery = (sql: string, parameters?: unknown[]) => Promise<any>;

/**
 * Ends an artefact (@0) as @1 at @2, only while it is still GRANTED: its status, its sealed care
 * contexts and its transfers' private keys, in one short transaction, the artefact row first (the row
 * a page store locks before it commits). Answers Changed: 1 when this call ended it, 0 when it had
 * already ended (another handler, or this call's own earlier try whose answer was lost). Small writes
 * only, so it commits at once even on a small database: the artefact's records are deleted afterwards,
 * a row at a time (purgeArtefactRecords), never in here.
 *
 * One ended artefact may change again: a CLOSED one (ClinicX's own ending) takes a REVOKED or EXPIRED
 * ABDM reports for it later, so its card shows what ABDM said. Nothing else is ever overwritten.
 */
export const END_ARTEFACT = `SET XACT_ABORT ON;
BEGIN TRANSACTION;
UPDATE AbdmHiuConsentArtefacts SET Status = @1, StatusAt = @2, CareContexts = NULL, UpdatedAt = @2 WHERE Id = @0 AND (Status = 'GRANTED' OR (Status = 'CLOSED' AND @1 IN ('REVOKED', 'EXPIRED')));
DECLARE @changed INT = @@ROWCOUNT;
UPDATE AbdmHiuDataRequests SET PrivateKey = NULL WHERE ArtefactFk = @0;
COMMIT TRANSACTION;
SELECT @changed AS Changed;`;

/** Roles.Id of the Patient role (as patient-registration.service and the patient list use it). */
export const PATIENT_ROLE_ID = "4FC67429-28AE-4106-93EF-436228282ED0";

export const jsonList = (value: string | null | undefined): string[] => {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
        return [];
    }
};

/** A request with its patient's current name and ABHA number (Users) and its artefact count. */
export const SELECT_REQUEST = `
    SELECT r.*,
           NULLIF(LTRIM(RTRIM(CONCAT(u.FirstName, ' ', u.LastName))), '') AS PatientName,
           u.AbhaNumber AS PatientAbhaNumber,
           (SELECT COUNT(1) FROM AbdmHiuConsentArtefacts a WHERE a.ConsentRequestFk = r.Id) AS ArtefactCount
    FROM AbdmHiuConsentRequests r
    LEFT JOIN Users u ON u.Id = r.PatientUserId`;

/**
 * Requests still REQUESTED with an ABDM id and HIU id, raised between @1 and @0, unchanged since @2,
 * the longest unchanged first, at most @3. Parameters in that order: waitingRequestsParams.
 */
export const LIST_WAITING_REQUESTS = `${SELECT_REQUEST}
    WHERE r.Status = 'REQUESTED' AND r.ConsentRequestId IS NOT NULL AND r.HiuId IS NOT NULL
      AND r.CreatedAt <= @0 AND r.CreatedAt >= @1 AND COALESCE(r.UpdatedAt, r.CreatedAt) <= @2
    ORDER BY COALESCE(r.UpdatedAt, r.CreatedAt), r.Id
    OFFSET 0 ROWS FETCH NEXT @3 ROWS ONLY`;

export const waitingRequestsParams = <T>(input: { raisedAfter: Date; raisedBefore: Date; checkedBefore: Date; limit: number }, time: (date: Date) => T): unknown[] =>
    [time(input.raisedBefore), time(input.raisedAfter), time(input.checkedBefore), input.limit];

/**
 * Makes @1 request @0's status check at @2, only while it is still REQUESTED and unchanged since @3.
 * One statement, so two instances never both claim it. Parameters in that order: statusCheckParams.
 */
export const CLAIM_STATUS_CHECK = `UPDATE AbdmHiuConsentRequests
    SET StatusRequestId = @1, UpdatedAt = @2
    OUTPUT inserted.Id
    WHERE Id = @0 AND Status = 'REQUESTED' AND COALESCE(UpdatedAt, CreatedAt) <= @3`;

export const statusCheckParams = <T>(input: { id: number; requestId: string; at: Date; checkedBefore: Date }, time: (date: Date) => T): unknown[] =>
    [input.id, input.requestId, time(input.at), time(input.checkedBefore)];

/**
 * GRANTED artefacts past their delete-by time at @0: their granted DataEraseAt, else (details never
 * fetched) their request's, returned as LapsedAt. The earliest first, at most @1. An artefact whose
 * request row is gone counts by its own DataEraseAt only. Parameters in that order:
 * lapsedArtefactsParams. Every time is bound from JS: the driver runs with useUTC=false, so the
 * database's own clock reads hours off the stored values.
 */
export const LIST_LAPSED_ARTEFACTS = `SELECT TOP (@1) a.*, COALESCE(a.DataEraseAt, r.DataEraseAt) AS LapsedAt
    FROM AbdmHiuConsentArtefacts a
    LEFT JOIN AbdmHiuConsentRequests r ON r.Id = a.ConsentRequestFk
    WHERE a.Status = 'GRANTED' AND COALESCE(a.DataEraseAt, r.DataEraseAt) <= @0
      AND (a.DataEraseAt IS NOT NULL OR a.CreatedAt IS NULL OR a.CreatedAt < r.DataEraseAt OR a.FetchAttempts >= @2)
    ORDER BY COALESCE(a.DataEraseAt, r.DataEraseAt), a.Id`;

/**
 * now, the limit, and how many fetches a grant without terms waits for (MAX_FETCH_ATTEMPTS): one
 * stored after its request's delete-by time lapses by the request's time only once those are spent
 * (the service's deleteByOf, the same rule).
 */
export const lapsedArtefactsParams = <T>(input: { now: Date; limit: number; maxFetchAttempts: number }, time: (date: Date) => T): unknown[] =>
    [time(input.now), input.limit, input.maxFetchAttempts];

/**
 * Ends, as EXPIRED at its own DataEraseAt, every request still GRANTED with no artefacts whose
 * DataEraseAt is at or before @0 (also its UpdatedAt). One statement, so two instances never both
 * end one. Parameters: expireEmptyRequestsParams.
 */
export const EXPIRE_EMPTY_REQUESTS = `UPDATE r SET Status = 'EXPIRED', StatusAt = r.DataEraseAt, UpdatedAt = @0
    OUTPUT inserted.Id, inserted.HospitalId, inserted.ConsentRequestId, inserted.StatusAt
    FROM AbdmHiuConsentRequests r
    WHERE r.Status = 'GRANTED' AND r.DataEraseAt <= @0
      AND NOT EXISTS (SELECT 1 FROM AbdmHiuConsentArtefacts a WHERE a.ConsentRequestFk = r.Id)`;

export const expireEmptyRequestsParams = <T>(now: Date, time: (date: Date) => T): unknown[] => [time(now)];

/**
 * Requests whose stored status no longer follows their artefacts, at most @0: PARTLY_REVOKED (no
 * longer written), GRANTED with an artefact revoked or lapsed, and REVOKED or EXPIRED through an
 * artefact while another facility is still GRANTED. Settling each closes what is still open.
 *
 * Two more, so a handler that lost a race (with the sweep, or another instance) is put right by the
 * next sweep:
 *   - REVOKED or EXPIRED, but an artefact ended before that (or revoked at that same moment while
 *     the request reads lapsed): the request did not take how it ended first.
 *   - A CLOSED artefact that was open at its delete-by time (stored before it) and closed at or after
 *     it: it had lapsed first, so settling moves it to EXPIRED and the request with it. One stored
 *     already CLOSED (granted after its request ended) was never open, and is not picked.
 * No time is bound: each clause compares stored values only.
 */
export const LIST_UNSETTLED_REQUESTS = `${SELECT_REQUEST}
    WHERE r.Status = 'PARTLY_REVOKED'
       OR (r.Status = 'GRANTED'
           AND EXISTS (SELECT 1 FROM AbdmHiuConsentArtefacts e WHERE e.ConsentRequestFk = r.Id AND e.Status IN ('REVOKED', 'EXPIRED')))
       OR (r.Status IN ('REVOKED', 'EXPIRED')
           AND EXISTS (SELECT 1 FROM AbdmHiuConsentArtefacts e WHERE e.ConsentRequestFk = r.Id AND e.Status IN ('REVOKED', 'EXPIRED'))
           AND EXISTS (SELECT 1 FROM AbdmHiuConsentArtefacts g WHERE g.ConsentRequestFk = r.Id AND g.Status = 'GRANTED'))
       OR (r.Status IN ('REVOKED', 'EXPIRED')
           AND EXISTS (SELECT 1 FROM AbdmHiuConsentArtefacts f WHERE f.ConsentRequestFk = r.Id AND f.Status IN ('REVOKED', 'EXPIRED')
                       AND (f.StatusAt < r.StatusAt OR (f.StatusAt = r.StatusAt AND f.Status = 'REVOKED' AND r.Status = 'EXPIRED'))))
       OR EXISTS (SELECT 1 FROM AbdmHiuConsentArtefacts c WHERE c.ConsentRequestFk = r.Id AND c.Status = 'CLOSED'
                  AND COALESCE(c.DataEraseAt, r.DataEraseAt) <= c.StatusAt AND c.CreatedAt < COALESCE(c.DataEraseAt, r.DataEraseAt))
    ORDER BY r.Id
    OFFSET 0 ROWS FETCH NEXT @0 ROWS ONLY`;

/**
 * An artefact's (alias a) record count as the records view shows it: the entries of one transfer,
 * its latest RECEIVED transfer holding entries, else its latest transfer holding entries (as
 * hiu-data.repository's SHOWN_TRANSFER), never the marker row of a page with no entries.
 */
export const ARTEFACT_RECORD_COUNT = `(SELECT COUNT(1) FROM AbdmHiuRecords rec
                     WHERE rec.ArtefactFk = a.Id AND rec.EntryIndex >= 0
                       AND rec.DataRequestFk = (SELECT TOP 1 dr.Id FROM AbdmHiuDataRequests dr
                           WHERE dr.ArtefactFk = a.Id
                             AND EXISTS (SELECT 1 FROM AbdmHiuRecords x WHERE x.DataRequestFk = dr.Id AND x.EntryIndex >= 0)
                           ORDER BY CASE WHEN dr.SessionStatus = 'RECEIVED' THEN 0 ELSE 1 END, dr.Id DESC))`;

/**
 * When the latest transfer's (d) newest page was stored: its records' latest ReceivedAt (a page with
 * no entries has its marker row), so an accepted page always counts and nothing is inferred from the
 * audit trail. NULL before any page; a transfer's records are only deleted with its artefact's.
 */
export const TRANSFER_LAST_PAGE_AT = `(SELECT MAX(lp.ReceivedAt) FROM AbdmHiuRecords lp WHERE lp.DataRequestFk = d.Id)`;

/**
 * A consent request's (@0) artefacts, each with its latest transfer (d), that transfer's record
 * count and newest page's time, and the latest push refused for that transfer (pr, PUSH_REFUSED:
 * its RequestId is the transfer's HiRequestId, under the request's consent request id, so the read
 * seeks the audit table's consent-request index). A refusal older than the newest page came before
 * pages that were accepted: the view sends both times and says which.
 */
export const LIST_ARTEFACTS = `SELECT a.*,
                    d.Id AS DrId, d.TransactionId AS DrTransactionId, d.SessionStatus AS DrSessionStatus,
                    d.PageCount AS DrPageCount, d.PagesReceived AS DrPagesReceived, d.Error AS DrError,
                    d.CreatedAt AS DrCreatedAt, d.CompletedAt AS DrCompletedAt,
                    ${TRANSFER_LAST_PAGE_AT} AS DrLastPageAt,
                    pr.At AS PrAt, pr.Detail AS PrDetail,
                    ${ARTEFACT_RECORD_COUNT} AS RecordCount
             FROM AbdmHiuConsentArtefacts a
             LEFT JOIN AbdmHiuConsentRequests cr ON cr.Id = a.ConsentRequestFk
             OUTER APPLY (
                 SELECT TOP 1 dr.Id, dr.HiRequestId, dr.TransactionId, dr.SessionStatus, dr.PageCount, dr.PagesReceived, dr.Error, dr.CreatedAt, dr.CompletedAt
                 FROM AbdmHiuDataRequests dr
                 WHERE dr.ArtefactFk = a.Id
                 ORDER BY dr.CreatedAt DESC, dr.Id DESC
             ) d
             OUTER APPLY (
                 SELECT TOP 1 e.At, e.Detail
                 FROM AbdmHiuAuditEvents e
                 WHERE e.ConsentRequestId = cr.ConsentRequestId AND e.HospitalId = a.HospitalId
                   AND e.Event = 'PUSH_REFUSED' AND e.RequestId = d.HiRequestId
                 ORDER BY e.At DESC, e.Id DESC
             ) pr
             WHERE a.ConsentRequestFk = @0
             ORDER BY a.Id`;

/** A date column's value, or null when it is empty or unreadable. */
const validDate = (value: unknown): Date | null => {
    if (value === null || value === undefined || value === "") return null;
    const date = new Date(value as any);
    return Number.isNaN(date.getTime()) ? null : date;
};

/** The latest refused push of a LIST_ARTEFACTS row (PrAt, PrDetail); null when there is none or its detail is unreadable. */
export const pushRefusalOf = (raw: any): PushRefusal | null => {
    if (!raw?.PrAt) return null;
    const at = new Date(raw.PrAt);
    const detail = readPushRefusalDetail(raw.PrDetail);
    return detail && !Number.isNaN(at.getTime()) ? { ...detail, at } : null;
};

/** A LIST_ARTEFACTS row's latest transfer; null when the artefact has none. */
export const toTransferRow = (raw: any): TransferRow | null => raw?.DrId == null ? null : {
    transactionId: raw.DrTransactionId ?? null,
    sessionStatus: raw.DrSessionStatus,
    pageCount: raw.DrPageCount ?? null,
    pagesReceived: Number(raw.DrPagesReceived ?? 0),
    error: raw.DrError ?? null,
    requestedAt: raw.DrCreatedAt ?? null,
    completedAt: raw.DrCompletedAt ?? null,
    lastPageAt: validDate(raw.DrLastPageAt),
    lastPushRefusal: pushRefusalOf(raw),
};

export const toRequestRow = (raw: any): ConsentRequestRow => ({
    id: Number(raw.Id),
    initRequestId: raw.InitRequestId,
    consentRequestId: raw.ConsentRequestId ?? null,
    statusRequestId: raw.StatusRequestId ?? null,
    hospitalId: Number(raw.HospitalId),
    hiuId: raw.HiuId ?? null,
    organizationId: raw.OrganizationId ?? null,
    staffUserId: String(raw.StaffUserId),
    staffName: raw.StaffName ?? null,
    patientUserId: String(raw.PatientUserId),
    patientName: raw.PatientName ?? null,
    patientAbhaNumber: raw.PatientAbhaNumber ?? null,
    abhaAddress: raw.AbhaAddress,
    purposeCode: raw.PurposeCode,
    hiTypes: jsonList(raw.HiTypes),
    dateFrom: raw.DateFrom,
    dateTo: raw.DateTo,
    dataEraseAt: raw.DataEraseAt,
    accessMode: raw.AccessMode,
    // A legacy PARTLY_REVOKED still loads: the sweep settles it (settleRequests).
    status: raw.Status as StoredConsentStatus,
    statusAt: raw.StatusAt,
    abdmErrorCode: raw.AbdmErrorCode ?? null,
    abdmError: raw.AbdmError ?? null,
    createdAt: raw.CreatedAt,
    artefactCount: Number(raw.ArtefactCount ?? 0),
});

/**
 * The patient [userId] when they are a patient of [hospitalId] in the same sense as the patient list
 * (GET /api/patients/getpatients, PatientRegistrationRepository.getPatients): a live registration,
 * an active Patient role in that registration's organization, and either the registration or the
 * role at this hospital. Anyone else (no Patient role, another hospital, deleted) is null.
 */
export const findPatientIn = async (
    query: HiuConsentQuery,
    userId: string,
    hospitalId: number,
): Promise<{ userId: string; name: string; abhaAddress: string | null; abhaNumber: string | null } | null> => {
    const rows = await query(
        `SELECT TOP 1 u.Id, u.FirstName, u.LastName, u.AbhaAddress, u.AbhaNumber
         FROM Users u
         INNER JOIN PatientRegistrations pr ON pr.UserId = u.Id AND pr.IsDeleted = 0
         INNER JOIN UserRoles ur ON ur.UserId = u.Id AND ur.IsDeleted = 0 AND ur.Status = 1
                                AND ur.RoleId = @2 AND ur.OrganizationId = pr.OrganizationId
         WHERE u.Id = @0 AND u.IsDeleted = 0 AND (pr.HospitalId = @1 OR ur.HospitalId = @1)`,
        [userId, hospitalId, PATIENT_ROLE_ID],
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    return {
        userId: String(row.Id),
        name: `${row.FirstName || ""} ${row.LastName || ""}`.trim(),
        abhaAddress: row.AbhaAddress ?? null,
        abhaNumber: row.AbhaNumber ?? null,
    };
};
