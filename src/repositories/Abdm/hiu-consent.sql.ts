import type { ConsentStatus } from "../../services/Abdm/hiu/hiu-enums.js";
import type { ConsentRequestRow } from "../../services/Abdm/hiu/hiu-consent.service.js";

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
 */
export const END_ARTEFACT = `SET XACT_ABORT ON;
BEGIN TRANSACTION;
UPDATE AbdmHiuConsentArtefacts SET Status = @1, StatusAt = @2, CareContexts = NULL, UpdatedAt = @2 WHERE Id = @0 AND Status = 'GRANTED';
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
    status: raw.Status as ConsentStatus,
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
