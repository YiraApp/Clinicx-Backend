import { Request, Response } from "express";
import { patientPrescriptionService } from "../../../../services/Appointments/patient-prescription.service.js";
import { ApiResponse } from "../../../../utils/response.utils.js";

const normalizeMedication = (med: any) => ({
    Medication: med.medication || med.Medication,
    ConceptId: med.conceptId || med.ConceptId,
    Dosage: med.dosage || med.Dosage,
    DurationValue: typeof med.durationValue === "number" ? med.durationValue : (med.durationValue ? parseInt(med.durationValue) : undefined),
    DurationUnit: med.durationUnit || med.Duration || med.duration || "Days",
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
        CreatedBy: source.createdBy || source.CreatedBy || "Doctor",
        CreatedAt: source.createdAt ? new Date(source.createdAt) : undefined,
        UpdatedAt: source.updatedAt ? new Date(source.updatedAt) : undefined,
        Diagnoses: diagnoses,
        Medications: medications,
        Notes: source.notes || source.Notes || source.prescriptionNotes || null
    };
};

export class MobilePrescriptionController {
    async getPatientPrescriptions(req: Request, res: Response) {
        try {
            const patientId = (req.params.patientId || req.query.patientId || req.body.patientId) as string;
            const { orgId, hospitalId, appointmentId } = req.query;

            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required"));
            }

            const prescriptions = await patientPrescriptionService.getPatientPrescriptions(
                patientId,
                orgId ? parseInt(String(orgId)) : undefined,
                hospitalId ? parseInt(String(hospitalId)) : undefined,
                appointmentId ? String(appointmentId) : undefined
            );

            return res.json(ApiResponse.success(prescriptions, "Prescriptions fetched successfully"));
        } catch (error: any) {
            console.error("Mobile Prescription Get Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async addPrescription(req: Request, res: Response) {
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
                if (!header.PatientId) {
                    return res.status(400).json(ApiResponse.error("Patient ID is required"));
                }
                results.push(await patientPrescriptionService.addPrescription(header));
            }

            return res.status(201).json(ApiResponse.success(results, "Prescription saved successfully"));
        } catch (error: any) {
            console.error("Mobile Prescription Add Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async updatePrescription(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const body = req.body;

            if (!id) {
                return res.status(400).json(ApiResponse.error("Prescription ID is required"));
            }

            const prescription = buildPrescriptionHeader(body);
            await patientPrescriptionService.updatePrescription(String(id), prescription);
            return res.json(ApiResponse.success(null, "Prescription updated successfully"));
        } catch (error: any) {
            console.error("Mobile Prescription Update Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async deletePrescription(req: Request, res: Response) {
        try {
            const { id } = req.params;
            if (!id) {
                return res.status(400).json(ApiResponse.error("Prescription ID is required"));
            }

            await patientPrescriptionService.deletePrescription(String(id));
            return res.json(ApiResponse.success(null, "Prescription deleted successfully"));
        } catch (error: any) {
            console.error("Mobile Prescription Delete Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const mobilePrescriptionController = new MobilePrescriptionController();
