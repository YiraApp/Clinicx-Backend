import { Request, Response } from "express";
import { patientMedicalRecordService } from "../../../../services/Appointments/patient-medical-record.service.js";
import { pushNotificationService } from "../../../../services/Notifications/push-notification.service.js";
import { AppDataSource } from "../../../../config/database.js";
import { User } from "../../../../models/Account/user.model.js";
import { ApiResponse } from "../../../../utils/response.utils.js";

export class MobileMedicalRecordController {
    async getPatientRecords(req: Request, res: Response) {
        try {
            const patientId = (req.params.patientId || req.query.patientId || req.body.patientId) as string;
            const { orgId, hospitalId, appointmentId } = req.query;

            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required"));
            }

            const records = await patientMedicalRecordService.getPatientRecords(
                patientId,
                orgId ? parseInt(String(orgId)) : undefined,
                hospitalId ? parseInt(String(hospitalId)) : undefined,
                appointmentId ? parseInt(String(appointmentId)) : undefined
            );

            return res.json(ApiResponse.success(records, "Medical records fetched successfully"));
        } catch (error: any) {
            console.error("Mobile Medical Record Get Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async addRecord(req: Request, res: Response) {
        try {
            const body = req.body;
            const data: any = {
                PatientId: body.patientId || body.PatientId,
                DoctorId: body.doctorId || body.DoctorId || (req as any).user?.userId,
                AppointmentId: body.appointmentId || body.AppointmentId,
                Type: body.type || body.Type || "Consultation",
                ChiefComplaint: body.chiefComplaint || body.ChiefComplaint,
                ChiefComplaintConceptId: body.chiefComplaintConceptId || body.ChiefComplaintConceptId,
                Symptoms: body.symptoms || body.Symptoms,
                SymptomConceptId: body.symptomConceptId || body.SymptomConceptId,
                PhysicalExamination: body.physicalExamination || body.examination || body.PhysicalExamination,
                PhysicalExaminationConceptId: body.physicalExaminationConceptId || body.PhysicalExaminationConceptId,
                Diagnosis: body.diagnosis || body.Diagnosis,
                DiagnosisConceptId: body.diagnosisConceptId || body.DiagnosisConceptId,
                Treatment: body.treatment || body.treatmentPlan || body.Treatment,
                TreatmentConceptId: body.treatmentConceptId || body.TreatmentConceptId,
                BloodPressure: body.bloodPressure || body.BloodPressure,
                HeartRate: body.heartRate || body.HeartRate,
                Temperature: body.temperature || body.Temperature,
                Weight: body.weight || body.Weight,
                Height: body.height || body.Height,
                OrganizationId: body.organizationId || body.OrganizationId,
                HospitalId: body.hospitalId || body.HospitalId,
                Status: body.status || body.Status || "Completed",
                CreatedBy: body.createdBy || body.CreatedBy || "Doctor"
            };

            if (data.AppointmentId) {
                data.AppointmentId = parseInt(String(data.AppointmentId));
            }

            if (!data.PatientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required"));
            }

            const record = await patientMedicalRecordService.addRecord(data);

            // Trigger Push Notification to Patient
            try {
                let doctorName = "Your doctor";
                if (data.DoctorId) {
                    const userRepo = AppDataSource.getRepository(User);
                    const doc = await userRepo.findOne({ where: { Id: data.DoctorId } });
                    if (doc) doctorName = `${doc.FirstName || ""} ${doc.LastName || ""}`.trim();
                }

                await pushNotificationService.notifyMedicalRecordAdded({
                    patientId: data.PatientId,
                    doctorId: data.DoctorId,
                    doctorName,
                    recordName: data.Type || data.ChiefComplaint || "Consultation Summary",
                    appointmentId: data.AppointmentId
                });
            } catch (e) {
                console.error("Failed to send medical record push notification:", e);
            }

            return res.status(201).json(ApiResponse.success(record, "Medical record created successfully"));
        } catch (error: any) {
            console.error("Mobile Medical Record Add Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async updateRecord(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const body = req.body;

            if (!id) {
                return res.status(400).json(ApiResponse.error("Record ID is required"));
            }

            const data: any = {};
            if (body.patientId !== undefined) data.PatientId = body.patientId;
            if (body.doctorId !== undefined) data.DoctorId = body.doctorId;
            if (body.appointmentId !== undefined) data.AppointmentId = body.appointmentId;
            if (body.type !== undefined) data.Type = body.type;
            if (body.chiefComplaint !== undefined) data.ChiefComplaint = body.chiefComplaint;
            if (body.chiefComplaintConceptId !== undefined) data.ChiefComplaintConceptId = body.chiefComplaintConceptId;
            if (body.symptoms !== undefined) data.Symptoms = body.symptoms;
            if (body.symptomConceptId !== undefined) data.SymptomConceptId = body.symptomConceptId;
            if (body.physicalExamination !== undefined) data.PhysicalExamination = body.physicalExamination;
            if (body.physicalExaminationConceptId !== undefined) data.PhysicalExaminationConceptId = body.physicalExaminationConceptId;
            if (body.diagnosis !== undefined) data.Diagnosis = body.diagnosis;
            if (body.diagnosisConceptId !== undefined) data.DiagnosisConceptId = body.diagnosisConceptId;
            if (body.treatment !== undefined) data.Treatment = body.treatment;
            if (body.treatmentConceptId !== undefined) data.TreatmentConceptId = body.treatmentConceptId;
            if (body.bloodPressure !== undefined) data.BloodPressure = body.bloodPressure;
            if (body.heartRate !== undefined) data.HeartRate = body.heartRate;
            if (body.temperature !== undefined) data.Temperature = body.temperature;
            if (body.weight !== undefined) data.Weight = body.weight;
            if (body.height !== undefined) data.Height = body.height;
            if (body.organizationId !== undefined) data.OrganizationId = body.organizationId;
            if (body.hospitalId !== undefined) data.HospitalId = body.hospitalId;
            if (body.status !== undefined) data.Status = body.status;
            if (body.updatedBy !== undefined) data.UpdatedBy = body.updatedBy;

            await patientMedicalRecordService.updateRecord(String(id), data);
            return res.json(ApiResponse.success(null, "Medical record updated successfully"));
        } catch (error: any) {
            console.error("Mobile Medical Record Update Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async deleteRecord(req: Request, res: Response) {
        try {
            const { id } = req.params;
            if (!id) {
                return res.status(400).json(ApiResponse.error("Record ID is required"));
            }

            await patientMedicalRecordService.deleteRecord(String(id));
            return res.json(ApiResponse.success(null, "Medical record deleted successfully"));
        } catch (error: any) {
            console.error("Mobile Medical Record Delete Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const mobileMedicalRecordController = new MobileMedicalRecordController();
