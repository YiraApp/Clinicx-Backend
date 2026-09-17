import { Request, Response } from "express";
import { patientPrescriptionService } from "../../services/Appointments/patient-prescription.service.js";
import { ApiResponse } from "../../utils/response.utils.js";
import { AppDataSource } from "../../config/database.js";

const normalizeMedication = (med: any) => ({
    Medication: med.medication || med.Medication,
    ConceptId: med.conceptId || med.ConceptId,
    Dosage: med.dosage || med.Dosage,
    DurationValue: typeof med.durationValue === "number" ? med.durationValue : undefined,
    DurationUnit: med.durationUnit || med.Duration || med.duration,
    FrequencyType: med.frequencyType || med.FrequencyType || med.frequency || med.Frequency,
    Instructions: med.instructions || med.Instructions,
    Route: med.route || med.Route,
    CreatedBy: med.createdBy || med.CreatedBy,
    UpdatedBy: med.updatedBy || med.UpdatedBy,
    Schedules: med.schedules,
    Days: med.days
});

const normalizeDiagnosis = (diag: any) => {
    if (!diag) return null;
    return {
        Diagnosis: typeof diag === "string" ? diag : diag.diagnosis || diag.Diagnosis,
        DiagnosisConceptId: diag.diagnosisConceptId || diag.DiagnosisConceptId
    };
};

const buildPrescriptionHeader = (source: any) => {
    const diagnoses = Array.isArray(source.diagnoses)
        ? source.diagnoses.map(normalizeDiagnosis).filter(Boolean)
        : source.diagnosis
            ? [normalizeDiagnosis(source)]
            : [];

    const medications = Array.isArray(source.medications)
        ? source.medications.map(normalizeMedication).filter((med: any) => !!med.Medication)
        : [normalizeMedication(source)].filter((med: any) => !!med.Medication);

    return {
        PatientId: source.patientId || source.PatientId,
        DoctorId: source.doctorId || source.DoctorId,
        AppointmentId: source.appointmentId ?? source.AppointmentId ?? null,
        MedicalRecordId: source.medicalRecordId || source.MedicalRecordId,
        OrganizationId: source.organizationId || source.OrganizationId || source.orgId || source.OrgId,
        HospitalId: source.hospitalId || source.HospitalId || source.hospId,
        CreatedBy: source.createdBy || source.CreatedBy,
        CreatedAt: source.createdAt ? new Date(source.createdAt) : undefined,
        UpdatedAt: source.updatedAt ? new Date(source.updatedAt) : undefined,
        Diagnoses: diagnoses,
        Medications: medications,
        Notes: source.notes || source.Notes || source.prescriptionNotes || null
    };
};

export class PatientPrescriptionController {
    async addPrescription(req: Request, res: Response): Promise<void> {
        try {
            const body = req.body;
            const results: any[] = [];

            if (Array.isArray(body) && !body[0]?.medications) {
                for (const item of body) {
                    const prescription = buildPrescriptionHeader(item);
                    results.push(await patientPrescriptionService.addPrescription(prescription));
                }
            } else {
                const header = buildPrescriptionHeader(body);
                results.push(await patientPrescriptionService.addPrescription(header));
            }

            res.status(201).json(ApiResponse.success(results, "Prescription added successfully"));
        } catch (error: any) {
            console.error("Error in addPrescription:", error);
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async getPatientPrescriptions(req: Request, res: Response): Promise<void> {
        try {
            const { patientId } = req.params;
            const { orgId, hospitalId, appointmentId } = req.query;

            const prescriptions = await patientPrescriptionService.getPatientPrescriptions(
                patientId as string,
                orgId ? parseInt(String(orgId)) : undefined,
                hospitalId ? parseInt(String(hospitalId)) : undefined,
                appointmentId ? String(appointmentId) : undefined
            );

            res.status(200).json(ApiResponse.success(prescriptions));
        } catch (error: any) {
            console.error("Error in getPatientPrescriptions:", error);
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async getPrescriptionsByAppointment(req: Request, res: Response): Promise<void> {
        try {
            const { appointmentId } = req.params;
            const { orgId, hospitalId } = req.query;

            const prescriptions = await patientPrescriptionService.getPrescriptionsByAppointment(
                appointmentId as string,
                orgId ? parseInt(String(orgId)) : undefined,
                hospitalId ? parseInt(String(hospitalId)) : undefined
            );

            res.status(200).json(ApiResponse.success(prescriptions));
        } catch (error: any) {
            console.error("Error in getPrescriptionsByAppointment:", error);
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async updatePrescription(req: Request, res: Response): Promise<void> {
        try {
            const id = req.params.id as string;
            const body = req.body;
            console.info("updatePrescription called", { id, body });
            const prescription = buildPrescriptionHeader(body);

            const host = req.get("host") || "192.168.68.94:5000";
            const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
            const pdfUrl = `${protocol}://${host}/v1/api/auth/prescriptions/${id}/pdf`;
            (prescription as any).PdfUrl = pdfUrl;

            await patientPrescriptionService.updatePrescription(id, prescription);

            // Update PdfUrl in database without re-uploading
            await AppDataSource.query("UPDATE PatientPrescription SET PdfUrl = @0, UpdatedAt = GETDATE() WHERE Id = @1", [pdfUrl, id]);

            // Update MedicalDocuments archive if existing
            try {
                await AppDataSource.query(
                    "UPDATE MedicalDocuments SET BlobUrl = @0, UpdatedAt = GETDATE() WHERE FileName LIKE @1 OR AppointmentId = @2",
                    [pdfUrl, `%${id}%`, prescription.AppointmentId ? Number(prescription.AppointmentId) : -1]
                );
            } catch (_) {}

            res.status(200).json(ApiResponse.success({ id, pdfUrl }, "Prescription updated successfully"));
        } catch (error: any) {
            console.error("Error in updatePrescription:", error);
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async deletePrescription(req: Request, res: Response): Promise<void> {
        try {
            const id = req.params.id as string;
            await patientPrescriptionService.deletePrescription(id);
            res.status(200).json(ApiResponse.success(null, "Prescription deleted successfully"));
        } catch (error: any) {
            console.error("Error in deletePrescription:", error);
            res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const patientPrescriptionController = new PatientPrescriptionController();
