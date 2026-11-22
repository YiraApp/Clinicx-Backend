import { AppDataSource } from "../../config/database.js";
import { MedicalDocument } from "../../models/Appointments/medical-document.model.js";
import { blobService } from "../Common/blob.service.js";

/** Category of the PDF filed for a medical record saved without a prescription. */
export const MEDICAL_RECORD_DOCUMENT_CATEGORY = "Medical Record";
const tagFor = (recordId: string) => `medical-record:${String(recordId).toLowerCase()}`;

/**
 * A medical record always ends up in a PDF in the patient's documents. When the visit has a
 * prescription the record is printed on the prescription's PDF; when it doesn't (the doctor only
 * wrote the record, or wrote it without an appointment) it gets a PDF of its own, kept here and
 * replaced each time the record changes. Once a prescription is written for the visit, the record's
 * own PDF is withdrawn so the patient doesn't see it twice.
 */
export class MedicalRecordDocumentService {
    /** Files (or replaces) the record's own PDF. Null when the visit has a prescription instead. */
    async saveToDocuments(recordId: string): Promise<{ url: string; documentId: number; fileName: string } | null> {
        const [record]: any[] = await AppDataSource.query(
            `SELECT TOP 1 * FROM PatientMedicalRecord WHERE CAST(Id AS NVARCHAR(64)) = @0 AND ISNULL(Status, '') <> 'Deleted'`,
            [String(recordId)]
        );
        if (!record) return null;
        const appointmentId = Number(record.AppointmentId) || 0;
        if (appointmentId && (await this.visitHasPrescription(appointmentId))) {
            await this.withdrawForAppointment(appointmentId);
            return null;
        }

        const { pdfBuffer, patientFolder } = await this.render(record);
        const fileName = `MedicalRecord_${String(record.Id).slice(0, 8)}.pdf`;
        // A new name for each version, so nobody is shown an old copy from a cache.
        const url = await blobService.uploadBuffer(pdfBuffer, `${patientFolder}/medical-records/MedicalRecord_${record.Id}_${Date.now()}.pdf`, "application/pdf");

        const tag = tagFor(record.Id);
        const now = new Date();
        const description = `Medical record${record.ChiefComplaint ? `: ${String(record.ChiefComplaint).trim()}` : ""}`.slice(0, 500);
        const [existing]: any[] = await AppDataSource.query(
            `SELECT TOP 1 Id FROM MedicalDocuments WHERE PatientId = @0 AND Tags = @1 AND ISNULL(IsDeleted, 0) = 0 ORDER BY Id DESC`,
            [String(record.PatientId), tag]
        );
        if (existing) {
            await AppDataSource.query(
                `UPDATE MedicalDocuments SET BlobUrl = @0, FileSize = @1, Description = @2, UpdatedAt = @3 WHERE Id = @4`,
                [url, pdfBuffer.length, description, now, existing.Id]
            );
            return { url, documentId: Number(existing.Id), fileName };
        }

        const document = new MedicalDocument();
        document.PatientId = String(record.PatientId);
        document.AppointmentId = appointmentId || undefined;
        document.DoctorId = record.DoctorId ? String(record.DoctorId) : undefined;
        document.OrganizationId = Number(record.OrganizationId) || undefined as any;
        document.HospitalId = Number(record.HospitalId) || undefined as any;
        document.DocumentCategory = MEDICAL_RECORD_DOCUMENT_CATEGORY;
        document.DocumentType = MEDICAL_RECORD_DOCUMENT_CATEGORY;
        // Never named Prescription_…: the prescription's own archive row is matched by that name.
        document.FileName = fileName;
        document.OriginalFileName = fileName;
        document.BlobUrl = url;
        document.MimeType = "application/pdf";
        document.FileExtension = ".pdf";
        document.FileSize = pdfBuffer.length;
        document.Description = description;
        document.Tags = tag;
        document.UploadedSource = "System";
        document.IsSystemGenerated = true;
        document.CreatedAt = now;
        document.CreatedBy = record.DoctorId ? String(record.DoctorId) : undefined;
        const saved = await AppDataSource.getRepository(MedicalDocument).save(document);
        return { url, documentId: Number(saved.Id), fileName };
    }

    /** The record (a PatientMedicalRecord row) drawn as a PDF of its own. */
    async render(record: any): Promise<{ pdfBuffer: Buffer; patientFolder: string }> {
        // Drawn with the prescription layout in its "medical record" form: same letterhead, doctor and
        // patient, the record's clinical sections, its diagnosis, treatment and follow-up.
        const { renderPrescriptionPdf } = await import("../../MobileApi/v1/controllers/provider/prescription.controller.js");
        const draft = {
            Id: undefined,
            PatientId: record.PatientId,
            DoctorId: record.DoctorId,
            HospitalId: record.HospitalId,
            OrganizationId: record.OrganizationId,
            AppointmentId: Number(record.AppointmentId) || undefined,
            MedicalRecordId: record.Id,
            Medications: [],
            Diagnoses: String(record.Diagnosis || "").trim() ? [String(record.Diagnosis).trim()] : [],
            Notes: record.Notes || undefined,
            CreatedAt: record.Date || record.CreatedAt || new Date(),
        };
        const { pdfBuffer, patientFolder } = await renderPrescriptionPdf(draft, { kind: "medicalRecord" }, []);
        return { pdfBuffer, patientFolder };
    }

    /** A record's PDF built fresh, for viewing. Null when there is no such record. */
    async buildPdf(recordId: string): Promise<{ buffer: Buffer; fileName: string; record: any } | null> {
        const [record]: any[] = await AppDataSource.query(
            `SELECT TOP 1 * FROM PatientMedicalRecord WHERE CAST(Id AS NVARCHAR(64)) = @0 AND ISNULL(Status, '') <> 'Deleted'`,
            [String(recordId)]
        );
        if (!record) return null;
        const { pdfBuffer } = await this.render(record);
        return { buffer: pdfBuffer, fileName: `MedicalRecord_${String(record.Id).slice(0, 8)}.pdf`, record };
    }

    /** The visit now has a prescription, which prints the record: withdraw the record's own PDFs. */
    async withdrawForAppointment(appointmentId: number): Promise<void> {
        if (!appointmentId) return;
        await AppDataSource.query(
            `UPDATE MedicalDocuments SET IsDeleted = 1, UpdatedAt = @1
             WHERE AppointmentId = @0 AND DocumentCategory = @2 AND Tags LIKE 'medical-record:%' AND ISNULL(IsDeleted, 0) = 0`,
            [appointmentId, new Date(), MEDICAL_RECORD_DOCUMENT_CATEGORY]
        );
    }

    /** The record was deleted: its own PDF goes too. */
    async withdrawForRecord(recordId: string): Promise<void> {
        await AppDataSource.query(
            `UPDATE MedicalDocuments SET IsDeleted = 1, UpdatedAt = @1 WHERE Tags = @0 AND ISNULL(IsDeleted, 0) = 0`,
            [tagFor(recordId), new Date()]
        );
    }

    private async visitHasPrescription(appointmentId: number): Promise<boolean> {
        // PatientPrescription keeps the appointment id as text.
        const rows: any[] = await AppDataSource.query(`SELECT TOP 1 Id FROM PatientPrescription WHERE AppointmentId = @0`, [String(appointmentId)]);
        return rows.length > 0;
    }
}

export const medicalRecordDocumentService = new MedicalRecordDocumentService();
