import { AppDataSource } from "../../config/database.js";

/**
 * Builds the PDFs of a visit's prescriptions again, after its medical record was added or changed,
 * so the PDF in the patient's documents shows the current clinical note. Runs in the background:
 * a failure is logged and never fails the request that saved the record.
 */
export function refreshAppointmentPrescriptionPdfs(appointmentId?: number | string | null, recordId?: string): void {
    void (async () => {
        let visit = Number(appointmentId) || 0;
        if (!visit && recordId) {
            const [row] = await AppDataSource.query(`SELECT TOP 1 AppointmentId FROM PatientMedicalRecord WHERE Id = @0`, [recordId]);
            visit = Number(row?.AppointmentId) || 0;
        }
        if (!visit) return;
        // PatientPrescription keeps the appointment id as text.
        const prescriptions: Array<{ Id: string }> = await AppDataSource.query(
            `SELECT Id FROM PatientPrescription WHERE AppointmentId = @0`,
            [String(visit)]
        );
        if (!prescriptions.length) return;
        // Loaded here to keep the medical record code free of the prescription controller's imports.
        const { uploadPrescriptionPdfToBlob } = await import("../../MobileApi/v1/controllers/provider/prescription.controller.js");
        for (const { Id } of prescriptions) {
            await uploadPrescriptionPdfToBlob(String(Id)).catch((error: any) =>
                console.error(`[PrescriptionPdf] Couldn't rebuild prescription ${Id} after its medical record changed:`, error?.message ?? error)
            );
        }
    })().catch((error: any) => console.error("[PrescriptionPdf] Rebuild after a medical record change failed:", error?.message ?? error));
}
