import { Request, Response } from "express";
import { patientMedicalRecordService } from "../../services/Appointments/patient-medical-record.service.js";
import { ApiResponse } from "../../utils/response.utils.js";
import { medicalRecordColumns } from "../../services/Appointments/medical-record-mapping.js";

export class PatientMedicalRecordController {
    async addRecord(req: Request, res: Response): Promise<void> {
        try {
            const data = medicalRecordColumns(req.body);
            const record = await patientMedicalRecordService.addRecord(data);
            res.status(201).json(ApiResponse.success(record, "Medical record added successfully"));
        } catch (error: any) {
            console.error("Error in addRecord:", error);
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async getPatientRecords(req: Request, res: Response): Promise<void> {
        try {
            const { patientId } = req.params;
            const { orgId, hospitalId, appointmentId } = req.query;

            const records = await patientMedicalRecordService.getPatientRecords(
                patientId as string,
                orgId ? parseInt(String(orgId)) : undefined,
                hospitalId ? parseInt(String(hospitalId)) : undefined,
                appointmentId ? parseInt(String(appointmentId)) : undefined
            );

            res.status(200).json(ApiResponse.success(records));
        } catch (error: any) {
            console.error("Error in getPatientRecords:", error);
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async updateRecord(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const body = req.body;
            
            const data: any = {};
            if (body.patientId !== undefined) data.PatientId = body.patientId;
            if (body.doctorId !== undefined) data.DoctorId = body.doctorId;
            if (body.appointmentId !== undefined) data.AppointmentId = body.appointmentId;
            if (body.type !== undefined) data.Type = body.type;
            if (body.chiefComplaint !== undefined) data.ChiefComplaint = body.chiefComplaint;
            if (body.chiefComplaintConceptId !== undefined) data.ChiefComplaintConceptId = body.chiefComplaintConceptId;
            if (body.symptoms !== undefined) data.Symptoms = body.symptoms;
            if (body.symptomConceptId !== undefined) data.SymptomConceptId = body.symptomConceptId;
            if (body.physicalExamination !== undefined || body.examination !== undefined) 
                data.PhysicalExamination = body.physicalExamination || body.examination;
            if (body.physicalExaminationConceptId !== undefined) 
                data.PhysicalExaminationConceptId = body.physicalExaminationConceptId;
            if (body.diagnosis !== undefined) data.Diagnosis = body.diagnosis;
            if (body.diagnosisConceptId !== undefined) data.DiagnosisConceptId = body.diagnosisConceptId;
            if (body.treatment !== undefined || body.treatmentPlan !== undefined) 
                data.Treatment = body.treatment || body.treatmentPlan;
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

            if (data.AppointmentId !== undefined) data.AppointmentId = parseInt(String(data.AppointmentId));

            await patientMedicalRecordService.updateRecord(id as string, data);
            res.status(200).json(ApiResponse.success(null, "Medical record updated successfully"));
        } catch (error: any) {
            console.error("Error in updateRecord:", error);
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async deleteRecord(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            await patientMedicalRecordService.deleteRecord(id as string);
            res.status(200).json(ApiResponse.success(null, "Medical record deleted successfully"));
        } catch (error: any) {
            console.error("Error in deleteRecord:", error);
            res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const patientMedicalRecordController = new PatientMedicalRecordController();
