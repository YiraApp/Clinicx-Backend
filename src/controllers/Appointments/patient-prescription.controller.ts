import { Request, Response } from "express";
import { patientPrescriptionService } from "../../services/Appointments/patient-prescription.service.js";
import { ApiResponse } from "../../utils/response.utils.js";
import { AppDataSource } from "../../config/database.js";
import { uploadPrescriptionPdfToBlob } from "../../MobileApi/v1/controllers/provider/prescription.controller.js";

const normalizeMedication = (med: any) => {
    let durVal: number | undefined = undefined;
    if (typeof med.durationValue === "number" && !isNaN(med.durationValue)) {
        durVal = med.durationValue;
    } else if (med.durationValue) {
        const parsed = parseInt(String(med.durationValue).replace(/[^0-9]/g, ""));
        if (!isNaN(parsed)) durVal = parsed;
    } else if (med.duration) {
        const parsed = parseInt(String(med.duration).replace(/[^0-9]/g, ""));
        if (!isNaN(parsed)) durVal = parsed;
    }

    return {
        Medication: med.medication || med.Medication || med.name || med.Name,
        ConceptId: med.conceptId || med.ConceptId,
        Dosage: med.dosage || med.Dosage,
        DurationValue: durVal,
        DurationUnit: med.durationUnit || med.DurationUnit || (med.duration && isNaN(Number(med.duration)) ? med.duration : "Days"),
        FrequencyType: med.frequencyType || med.FrequencyType || med.frequency || med.Frequency,
        Instructions: med.instructions || med.Instructions || med.note || med.Note,
        Route: med.route || med.Route,
        CreatedBy: med.createdBy || med.CreatedBy,
        UpdatedBy: med.updatedBy || med.UpdatedBy,
        Schedules: med.schedules,
        Days: med.days
    };
};

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
        DoctorId: source.doctorId || source.DoctorId || null,
        AppointmentId: source.appointmentId ?? source.AppointmentId ?? null,
        MedicalRecordId: source.medicalRecordId || source.MedicalRecordId,
        OrganizationId: source.organizationId || source.OrganizationId || source.orgId || source.OrgId,
        HospitalId: source.hospitalId || source.HospitalId || source.hospId,
        CreatedBy: source.createdBy || source.CreatedBy,
        CreatedAt: source.createdAt ? new Date(source.createdAt) : undefined,
        UpdatedAt: source.updatedAt ? new Date(source.updatedAt) : undefined,
        Diagnoses: diagnoses,
        Medications: medications,
        Notes: source.notes || source.Notes || source.prescriptionNotes || null,
        PdfUrl: source.pdfUrl || source.PdfUrl || null
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
                    const saved = await patientPrescriptionService.addPrescription(prescription);
                    const isManual = Boolean(item.isManual || item.isPatientManual || item.type === "manual" || (!item.doctorId && !item.DoctorId));
                    if (saved?.Id && !isManual) {
                        try {
                            const blobUrl = await uploadPrescriptionPdfToBlob(String(saved.Id), item);
                            saved.PdfUrl = blobUrl;
                            (saved as any).pdfUrl = blobUrl;
                        } catch (blobErr) {
                            console.error("[PatientPrescriptionController] Azure Blob upload error:", blobErr);
                        }
                    }
                    results.push(saved);
                }
            } else {
                const header = buildPrescriptionHeader(body);
                const saved = await patientPrescriptionService.addPrescription(header);
                const isManual = Boolean(body.isManual || body.isPatientManual || body.type === "manual" || (!body.doctorId && !body.DoctorId));
                if (saved?.Id && !isManual) {
                    try {
                        const blobUrl = await uploadPrescriptionPdfToBlob(String(saved.Id), body);
                        saved.PdfUrl = blobUrl;
                        (saved as any).pdfUrl = blobUrl;
                    } catch (blobErr) {
                        console.error("[PatientPrescriptionController] Azure Blob upload error:", blobErr);
                    }
                }
                results.push(saved);
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

            await patientPrescriptionService.updatePrescription(id, prescription);

            // Generate and upload updated PDF directly to Azure Blob Storage
            let pdfUrl: string = body.pdfUrl || body.PdfUrl || "";
            if (!pdfUrl || !pdfUrl.startsWith("http") || pdfUrl.includes("localhost") || pdfUrl.includes("192.168.")) {
                try {
                    pdfUrl = await uploadPrescriptionPdfToBlob(id, body);
                } catch (uploadErr) {
                    console.error("[PatientPrescriptionController] Failed to upload updated PDF to Azure Blob:", uploadErr);
                }
            }

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
