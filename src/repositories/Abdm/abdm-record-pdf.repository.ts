import { AppDataSource } from "../../config/database.js";

/**
 * AbdmRecordPdfs: every distinct PDF each shared record has carried, stored in the private blob
 * container. A record is its care context reference plus its bundle id (RecordKey); a version is
 * one PDF of it (Sha1). Rows are only added, never changed.
 */

export interface StoredPdf {
    id: string;
    hospitalId: number;
    patientUserId: string;
    reference: string;
    hiType: string;
    recordKey: string;
    source: "generated" | "signed-copy";
    sha1: string;
    bytes: number;
    blobUrl: string;
    createdAt: Date;
}

export interface RecordPdfStore {
    has(hospitalId: number, reference: string, recordKey: string, sha1: string): Promise<boolean>;
    add(row: Omit<StoredPdf, "id">): Promise<void>;
    /** Newest first. */
    list(hospitalId: number, reference: string, recordKey: string): Promise<StoredPdf[]>;
    get(hospitalId: number, reference: string, recordKey: string, id: string): Promise<StoredPdf | null>;
}

const COLUMNS = "Id, HospitalId, PatientUserId, CareContextReference, HiType, RecordKey, Source, Sha1, Bytes, BlobUrl, CreatedAt";

const toStored = (r: any): StoredPdf => ({
    id: String(r.Id),
    hospitalId: Number(r.HospitalId),
    patientUserId: String(r.PatientUserId),
    reference: String(r.CareContextReference),
    hiType: String(r.HiType),
    recordKey: String(r.RecordKey),
    source: r.Source === "signed-copy" ? "signed-copy" : "generated",
    sha1: String(r.Sha1).trim(),
    bytes: Number(r.Bytes),
    blobUrl: String(r.BlobUrl),
    createdAt: new Date(r.CreatedAt),
});

export const abdmRecordPdfRepository: RecordPdfStore = {
    async has(hospitalId, reference, recordKey, sha1) {
        const rows = await AppDataSource.query(
            `SELECT TOP 1 Id FROM AbdmRecordPdfs WHERE HospitalId = @0 AND CareContextReference = @1 AND RecordKey = @2 AND Sha1 = @3`,
            [hospitalId, reference, recordKey, sha1],
        );
        return rows.length > 0;
    },

    async add(r) {
        // The unique index guards a race between two saves of the same record; the check keeps it quiet
        await AppDataSource.query(
            `IF NOT EXISTS (SELECT 1 FROM AbdmRecordPdfs WHERE HospitalId = @0 AND CareContextReference = @2 AND RecordKey = @4 AND Sha1 = @6)
             INSERT INTO AbdmRecordPdfs (HospitalId, PatientUserId, CareContextReference, HiType, RecordKey, Source, Sha1, Bytes, BlobUrl, CreatedAt)
             VALUES (@0, @1, @2, @3, @4, @5, @6, @7, @8, @9)`,
            [r.hospitalId, r.patientUserId, r.reference, r.hiType, r.recordKey, r.source, r.sha1, r.bytes, r.blobUrl, r.createdAt],
        );
    },

    async list(hospitalId, reference, recordKey) {
        const rows = await AppDataSource.query(
            `SELECT ${COLUMNS} FROM AbdmRecordPdfs WHERE HospitalId = @0 AND CareContextReference = @1 AND RecordKey = @2 ORDER BY CreatedAt DESC, Id DESC`,
            [hospitalId, reference, recordKey],
        );
        return rows.map(toStored);
    },

    async get(hospitalId, reference, recordKey, id) {
        if (!/^\d{1,18}$/.test(id)) return null;
        const rows = await AppDataSource.query(
            `SELECT ${COLUMNS} FROM AbdmRecordPdfs WHERE Id = @0 AND HospitalId = @1 AND CareContextReference = @2 AND RecordKey = @3`,
            [id, hospitalId, reference, recordKey],
        );
        return rows[0] ? toStored(rows[0]) : null;
    },
};
