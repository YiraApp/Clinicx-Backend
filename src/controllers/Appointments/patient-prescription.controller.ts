import { Request, Response } from "express";
import { patientPrescriptionService } from "../../services/Appointments/patient-prescription.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class PatientPrescriptionController {
    async addPrescription(req: Request, res: Response): Promise<void> {
        try {
            const body = req.body;
            // Handle both single and array of medications
            const medications = Array.isArray(body) ? body : [body];
            
            const results = [];
            for (const med of medications) {
                const data: any = {
                    PatientId: med.patientId || med.PatientId,
                    DoctorId: med.doctorId || med.DoctorId,
                    AppointmentId: med.appointmentId || med.AppointmentId || "0",
                    MedicalRecordId: med.medicalRecordId || med.MedicalRecordId,
                    Medication: med.medication || med.Medication,
                    ConceptId: med.conceptId || med.ConceptId,
                    Dosage: med.dosage || med.Dosage,
                    Frequency: med.frequency || med.Frequency,
                    Duration: med.duration || med.Duration,
                    Route: med.route || med.Route,
                    Diagnosis: med.diagnosis || med.Diagnosis,
                    DiagnosisConceptId: med.diagnosisConceptId || med.DiagnosisConceptId,
                    Instructions: med.instructions || med.Instructions,
                    OrganizationId: med.organizationId || med.OrganizationId,
                    HospitalId: med.hospitalId || med.HospitalId,
                    CreatedBy: med.createdBy || med.CreatedBy
                };
                
                const result = await patientPrescriptionService.addPrescription(data);
                results.push(result);
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
                appointmentId as string
            );

            res.status(200).json(ApiResponse.success(prescriptions));
        } catch (error: any) {
            console.error("Error in getPatientPrescriptions:", error);
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async deletePrescription(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            await patientPrescriptionService.deletePrescription(id);
            res.status(200).json(ApiResponse.success(null, "Prescription deleted successfully"));
        } catch (error: any) {
            console.error("Error in deletePrescription:", error);
            res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const patientPrescriptionController = new PatientPrescriptionController();
