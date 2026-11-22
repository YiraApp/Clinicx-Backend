import { AppDataSource } from "../../config/database.js";

/**
 * Keeps a medical record's PDF current after it was added or changed. When the visit has a
 * prescription, its PDFs are built again (they print the record); otherwise the record gets a PDF
 * of its own in the patient's documents. Runs in the background: a failure is logged and never
 * fails the request that saved the record.
 */
export function refreshAppointmentPrescriptionPdfs(appointmentId?: number | string | null, recordId?: string): void {
    void (async () => {
        let visit = Number(appointmentId) || 0;
        if (!visit && recordId) {
            const [row] = await AppDataSource.query(`SELECT TOP 1 AppointmentId FROM PatientMedicalRecord WHERE Id = @0`, [recordId]);
            visit = Number(row?.AppointmentId) || 0;
        }
        // PatientPrescription keeps the appointment id as text.
        const prescriptions: Array<{ Id: string }> = visit
            ? await AppDataSource.query(`SELECT Id FROM PatientPrescription WHERE AppointmentId = @0`, [String(visit)])
            : [];
        if (!prescriptions.length) {
            // A record on its own (no prescription for the visit, or no visit): its own PDF
            if (recordId) {
                const { medicalRecordDocumentService } = await import("./medical-record-document.service.js");
                await medicalRecordDocumentService.saveToDocuments(recordId).catch((error: any) =>
                    console.error(`[MedicalRecordPdf] Couldn't file the PDF of medical record ${recordId}:`, error?.message ?? error)
                );
            }
            return;
        }
        // Loaded here to keep the medical record code free of the prescription controller's imports.
        const { uploadPrescriptionPdfToBlob } = await import("../../MobileApi/v1/controllers/provider/prescription.controller.js");
        for (const { Id } of prescriptions) {
            await uploadPrescriptionPdfToBlob(String(Id)).catch((error: any) =>
                console.error(`[PrescriptionPdf] Couldn't rebuild prescription ${Id} after its medical record changed:`, error?.message ?? error)
            );
        }
    })().catch((error: any) => console.error("[PrescriptionPdf] Rebuild after a medical record change failed:", error?.message ?? error));
}
