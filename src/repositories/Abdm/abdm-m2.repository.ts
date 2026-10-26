import { AppDataSource } from "../../config/database.js";
import type { HiType } from "../../services/Abdm/fhir/fhir-common.js";
import type {
    CareContextRow, CareContextSeed, ConsentRow, LinkRequestRow, LinkStatePatch, M2Store, PatientProfile, TransferRow,
} from "../../services/Abdm/m2/m2-store.js";
import type { RecordOwners, RecordRef } from "../../services/Abdm/m2/auto-link.js";

/** M2's state on SQL Server: the AbdmCareContexts, AbdmLinkTokens, AbdmLinkRequests, AbdmConsents and AbdmDataTransfers tables. */

const q = (sql: string, params: unknown[] = []): Promise<any[]> => AppDataSource.query(sql, params);
const list = (csv: string | null | undefined): HiType[] => (csv ? (csv.split(",").filter(Boolean) as HiType[]) : []);
const json = <T>(text: string | null | undefined, fallback: T): T => {
    if (!text) return fallback;
    try {
        return JSON.parse(text) as T;
    } catch {
        return fallback;
    }
};
const isDuplicateKey = (error: any): boolean => [2627, 2601].includes(error?.number ?? error?.driverError?.number);

const careContext = (r: any): CareContextRow => ({
    id: r.Id,
    hipId: r.HipId,
    referenceNumber: r.ReferenceNumber,
    patientUserId: String(r.PatientUserId).toLowerCase(),
    hospitalId: r.HospitalId,
    kind: r.Kind,
    sourceId: r.SourceId,
    recordDate: new Date(r.RecordDate),
    display: r.Display,
    hiTypes: list(r.HiTypes),
    linkStatus: r.LinkStatus,
    linkedVia: r.LinkedVia ?? null,
    linkedAbhaAddress: r.LinkedAbhaAddress ?? null,
    linkRequestId: r.LinkRequestId ?? null,
    linkedAt: r.LinkedAt ? new Date(r.LinkedAt) : null,
    notifiedHiTypes: list(r.NotifiedHiTypes),
    lastError: r.LastError ?? null,
});

const PATIENT_COLUMNS = `u.Id, u.FirstName, u.LastName, u.Gender, CONVERT(varchar(10), u.DateOfBirth, 23) AS DateOfBirth, u.PhoneNumber, u.AbhaNumber, u.AbhaAddress`;
const patient = (r: any): PatientProfile => ({
    userId: String(r.Id).toLowerCase(),
    name: [r.FirstName, r.LastName].map((p: string | null) => p?.trim()).filter(Boolean).join(" ") || "Patient",
    gender: r.Gender ?? null,
    birthDate: r.DateOfBirth ?? null,
    phone: r.PhoneNumber ?? null,
    abhaNumber: r.AbhaNumber ?? null,
    abhaAddress: r.AbhaAddress ?? null,
});

export class AbdmM2Repository implements M2Store {
    async patient(userId: string): Promise<PatientProfile | null> {
        const rows = await q(`SELECT ${PATIENT_COLUMNS} FROM Users u WHERE u.Id = @0 AND u.IsDeleted = 0`, [userId]);
        return rows[0] ? patient(rows[0]) : null;
    }

    async patientsAt(hospitalId: number, c: { abhaAddress?: string; abhaNumber?: string; mobile?: string; userId?: string }): Promise<PatientProfile[]> {
        const where: string[] = [];
        const params: unknown[] = [hospitalId];
        const add = (clause: (i: number) => string, value: unknown) => {
            params.push(value);
            where.push(clause(params.length - 1));
        };
        if (c.abhaAddress) add((i) => `LOWER(u.AbhaAddress) = LOWER(@${i})`, c.abhaAddress);
        if (c.abhaNumber) add((i) => `REPLACE(u.AbhaNumber, '-', '') = @${i}`, c.abhaNumber.replace(/\D/g, ""));
        // Mobiles are stored with or without +91: compare the last ten digits
        if (c.mobile) add((i) => `RIGHT(REPLACE(REPLACE(u.PhoneNumber, '+', ''), ' ', ''), 10) = @${i}`, c.mobile.replace(/\D/g, "").slice(-10));
        if (c.userId) add((i) => `u.Id = TRY_CONVERT(uniqueidentifier, @${i})`, c.userId);
        if (!where.length) return [];
        const rows = await q(
            `SELECT DISTINCT ${PATIENT_COLUMNS}
             FROM Users u INNER JOIN PatientRegistrations pr ON pr.UserId = u.Id AND pr.HospitalId = @0 AND pr.IsDeleted = 0
             WHERE u.IsDeleted = 0 AND (${where.join(" OR ")})`,
            params,
        );
        return rows.map(patient);
    }

    async patientsWithAbhaAt(hospitalId: number): Promise<string[]> {
        const rows = await q(
            `SELECT DISTINCT u.Id FROM Users u INNER JOIN PatientRegistrations pr ON pr.UserId = u.Id AND pr.HospitalId = @0 AND pr.IsDeleted = 0
             WHERE u.IsDeleted = 0 AND u.AbhaAddress IS NOT NULL AND u.AbhaAddress <> ''`,
            [hospitalId],
        );
        return rows.map((r) => String(r.Id).toLowerCase());
    }

    async appointmentIds(patientUserId: string, hospitalId: number): Promise<number[]> {
        const rows = await q(`SELECT Id FROM Appointments WHERE UserId = @0 AND HospitalId = @1 ORDER BY AppointmentDate`, [patientUserId, hospitalId]);
        return rows.map((r) => Number(r.Id));
    }

    async upsertCareContexts(seeds: CareContextSeed[]): Promise<void> {
        for (const s of seeds) {
            // A care context keeps its link state; what it holds and how it reads can change.
            await q(
                `MERGE AbdmCareContexts AS t
                 USING (SELECT @0 AS HipId, @1 AS ReferenceNumber) AS s ON t.HipId = s.HipId AND t.ReferenceNumber = s.ReferenceNumber
                 WHEN MATCHED THEN UPDATE SET Display = @6, HiTypes = @7, RecordDate = @5, UpdatedAt = GETDATE()
                 WHEN NOT MATCHED THEN INSERT (HipId, ReferenceNumber, PatientUserId, HospitalId, Kind, SourceId, RecordDate, Display, HiTypes)
                     VALUES (@0, @1, @2, @3, @4, @8, @5, @6, @7);`,
                [s.hipId, s.referenceNumber, s.patientUserId, s.hospitalId, s.kind, s.recordDate, s.display, s.hiTypes.join(","), s.sourceId],
            );
        }
    }

    async careContexts(patientUserId: string, hipId: string): Promise<CareContextRow[]> {
        return (await q(`SELECT * FROM AbdmCareContexts WHERE PatientUserId = @0 AND HipId = @1 ORDER BY RecordDate DESC`, [patientUserId, hipId])).map(careContext);
    }

    async careContextsByRefs(hipId: string, refs: string[]): Promise<CareContextRow[]> {
        if (!refs.length) return [];
        const placeholders = refs.map((_, i) => `@${i + 1}`).join(", ");
        return (await q(`SELECT * FROM AbdmCareContexts WHERE HipId = @0 AND ReferenceNumber IN (${placeholders})`, [hipId, ...refs])).map(careContext);
    }

    async careContextsByLinkRequest(requestId: string): Promise<CareContextRow[]> {
        return (await q(`SELECT * FROM AbdmCareContexts WHERE LinkRequestId = @0`, [requestId])).map(careContext);
    }

    async setLinkState(ids: number[], patch: LinkStatePatch): Promise<void> {
        if (!ids.length) return;
        const columns: Record<string, string> = {
            linkStatus: "LinkStatus", linkedVia: "LinkedVia", linkedAbhaAddress: "LinkedAbhaAddress", linkRequestId: "LinkRequestId",
            linkedAt: "LinkedAt", notifiedHiTypes: "NotifiedHiTypes", lastError: "LastError",
        };
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const [key, column] of Object.entries(columns)) {
            if (!(key in patch)) continue;
            const value = (patch as any)[key];
            params.push(Array.isArray(value) ? value.join(",") : key === "lastError" && value ? String(value).slice(0, 500) : value);
            sets.push(`${column} = @${params.length - 1}`);
        }
        if (!sets.length) return;
        const idParams = ids.map((id) => {
            params.push(id);
            return `@${params.length - 1}`;
        });
        await q(`UPDATE AbdmCareContexts SET ${sets.join(", ")}, UpdatedAt = GETDATE() WHERE Id IN (${idParams.join(", ")})`, params);
    }

    async linkToken(patientUserId: string, hipId: string, validAfter: Date) {
        const rows = await q(
            `SELECT TOP 1 LinkToken, AbhaAddress, ExpiresAt FROM AbdmLinkTokens WHERE PatientUserId = @0 AND HipId = @1 AND ExpiresAt > @2 ORDER BY ExpiresAt DESC`,
            [patientUserId, hipId, validAfter],
        );
        return rows[0] ? { token: rows[0].LinkToken, abhaAddress: rows[0].AbhaAddress, expiresAt: new Date(rows[0].ExpiresAt) } : null;
    }

    async saveLinkToken(r: { patientUserId: string; hipId: string; abhaAddress: string; token: string; expiresAt: Date; requestId: string }): Promise<void> {
        await q(
            `INSERT INTO AbdmLinkTokens (PatientUserId, HipId, AbhaAddress, LinkToken, ExpiresAt, RequestId) VALUES (@0, @1, @2, @3, @4, @5)`,
            [r.patientUserId, r.hipId, r.abhaAddress, r.token, r.expiresAt, r.requestId],
        );
    }

    async dropLinkTokens(patientUserId: string, hipId: string): Promise<void> {
        await q(`DELETE FROM AbdmLinkTokens WHERE PatientUserId = @0 AND HipId = @1`, [patientUserId, hipId]);
    }

    async createLinkRequest(r: LinkRequestRow): Promise<void> {
        await q(
            `INSERT INTO AbdmLinkRequests (LinkRefNumber, TransactionId, HipId, PatientUserId, AbhaAddress, CareContextRefs, OtpHash, OtpExpiresAt, Attempts, Status)
             VALUES (@0, @1, @2, @3, @4, @5, @6, @7, @8, @9)`,
            [r.linkRefNumber, r.transactionId, r.hipId, r.patientUserId, r.abhaAddress, JSON.stringify(r.careContextRefs), r.otpHash, r.otpExpiresAt, r.attempts, r.status],
        );
    }

    async linkRequest(linkRefNumber: string): Promise<LinkRequestRow | null> {
        const r = (await q(`SELECT * FROM AbdmLinkRequests WHERE LinkRefNumber = @0`, [linkRefNumber]))[0];
        return r ? {
            linkRefNumber: r.LinkRefNumber, transactionId: r.TransactionId, hipId: r.HipId, patientUserId: String(r.PatientUserId).toLowerCase(),
            abhaAddress: r.AbhaAddress, careContextRefs: json<string[]>(r.CareContextRefs, []), otpHash: r.OtpHash,
            otpExpiresAt: new Date(r.OtpExpiresAt), attempts: r.Attempts, status: r.Status,
        } : null;
    }

    async updateLinkRequest(linkRefNumber: string, patch: Partial<Pick<LinkRequestRow, "attempts" | "status">>): Promise<void> {
        await q(
            `UPDATE AbdmLinkRequests SET Attempts = COALESCE(@1, Attempts), Status = COALESCE(@2, Status), UpdatedAt = GETDATE() WHERE LinkRefNumber = @0`,
            [linkRefNumber, patch.attempts ?? null, patch.status ?? null],
        );
    }

    async saveConsent(c: ConsentRow & { artefact: string | null; signature: string | null }): Promise<void> {
        await q(
            `MERGE AbdmConsents AS t USING (SELECT @0 AS ConsentId) AS s ON t.ConsentId = s.ConsentId
             WHEN MATCHED THEN UPDATE SET Status = @2,
                 PatientAbhaAddress = COALESCE(@3, t.PatientAbhaAddress), HiuId = COALESCE(@4, t.HiuId), HiTypes = COALESCE(@5, t.HiTypes),
                 CareContexts = COALESCE(@6, t.CareContexts), DateFrom = COALESCE(@7, t.DateFrom), DateTo = COALESCE(@8, t.DateTo),
                 DataEraseAt = COALESCE(@9, t.DataEraseAt), Purpose = COALESCE(@10, t.Purpose), Artefact = COALESCE(@11, t.Artefact),
                 Signature = COALESCE(@12, t.Signature), UpdatedAt = GETDATE()
             WHEN NOT MATCHED THEN INSERT (ConsentId, HipId, Status, PatientAbhaAddress, HiuId, HiTypes, CareContexts, DateFrom, DateTo, DataEraseAt, Purpose, Artefact, Signature)
                 VALUES (@0, @1, @2, @3, @4, @5, @6, @7, @8, @9, @10, @11, @12);`,
            [
                c.consentId, c.hipId, c.status, c.patientAbhaAddress, c.hiuId,
                c.hiTypes.length ? JSON.stringify(c.hiTypes) : null, c.careContexts.length ? JSON.stringify(c.careContexts) : null,
                c.dateFrom, c.dateTo, c.dataEraseAt, c.purpose, c.artefact, c.signature,
            ],
        );
    }

    async consent(consentId: string): Promise<ConsentRow | null> {
        const r = (await q(`SELECT * FROM AbdmConsents WHERE ConsentId = @0`, [consentId]))[0];
        return r ? {
            consentId: r.ConsentId, hipId: r.HipId, status: r.Status, patientAbhaAddress: r.PatientAbhaAddress ?? null, hiuId: r.HiuId ?? null,
            hiTypes: json<HiType[]>(r.HiTypes, []), careContexts: json(r.CareContexts, []),
            dateFrom: r.DateFrom ? new Date(r.DateFrom) : null, dateTo: r.DateTo ? new Date(r.DateTo) : null,
            dataEraseAt: r.DataEraseAt ? new Date(r.DataEraseAt) : null, purpose: r.Purpose ?? null,
        } : null;
    }

    async createTransfer(t: TransferRow): Promise<"created" | "duplicate"> {
        try {
            await q(
                `INSERT INTO AbdmDataTransfers (TransactionId, ConsentId, HipId, RequestId, DataPushUrl, Status) VALUES (@0, @1, @2, @3, @4, @5)`,
                [t.transactionId, t.consentId, t.hipId, t.requestId, t.dataPushUrl, t.status],
            );
            return "created";
        } catch (error) {
            if (isDuplicateKey(error)) return "duplicate";
            throw error;
        }
    }

    async updateTransfer(transactionId: string, patch: Partial<Pick<TransferRow, "status" | "results" | "error">> & { completed?: boolean }): Promise<void> {
        await q(
            `UPDATE AbdmDataTransfers SET Status = COALESCE(@1, Status), Results = COALESCE(@2, Results), Error = COALESCE(@3, Error),
                 CompletedAt = CASE WHEN @4 = 1 THEN GETDATE() ELSE CompletedAt END
             WHERE TransactionId = @0`,
            [transactionId, patch.status ?? null, patch.results === undefined ? null : JSON.stringify(patch.results), patch.error?.slice(0, 500) ?? null, patch.completed ? 1 : 0],
        );
    }
}

export const abdmM2Repository = new AbdmM2Repository();

/** Whose a saved record is: a prescription line by its prescription, a visit record by its appointment's patient and hospital. */
export const abdmRecordOwners: RecordOwners = {
    async owner(ref: RecordRef) {
        let { patientId, hospitalId, appointmentId } = ref;
        if (ref.prescriptionId) {
            const rx = (await q(`SELECT PatientId, HospitalId, AppointmentId FROM PatientPrescription WHERE Id = @0`, [ref.prescriptionId]))[0];
            if (!rx) return null;
            ({ PatientId: patientId, HospitalId: hospitalId } = rx);
            appointmentId = Number(rx.AppointmentId) || null;
        }
        if (appointmentId) {
            const appointment = (await q(`SELECT UserId, HospitalId FROM Appointments WHERE Id = @0`, [appointmentId]))[0];
            if (appointment?.UserId && appointment.HospitalId) return { patientId: String(appointment.UserId).toLowerCase(), hospitalId: Number(appointment.HospitalId) };
        }
        return patientId && hospitalId ? { patientId: String(patientId).toLowerCase(), hospitalId: Number(hospitalId) } : null;
    },
};
