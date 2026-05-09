import { patientMedicalRecordRepository } from "../../repositories/Appointments/patient-medical-record.repository.js";
import { PatientMedicalRecord } from "../../models/Appointments/patient-medical-record.model.js";

export class PatientMedicalRecordService {
    async addRecord(data: Partial<PatientMedicalRecord>): Promise<PatientMedicalRecord> {
        return await patientMedicalRecordRepository.create(data);
    }

    async getPatientRecords(patientId: string, orgId?: number, hospitalId?: number, appointmentId?: number): Promise<PatientMedicalRecord[]> {
        return await patientMedicalRecordRepository.findByPatient(patientId, orgId, hospitalId, appointmentId);
    }

    async getRecordById(id: string): Promise<PatientMedicalRecord | null> {
        return await patientMedicalRecordRepository.findById(id);
    }

    async updateRecord(id: string, data: Partial<PatientMedicalRecord>): Promise<void> {
        await patientMedicalRecordRepository.update(id, data);
    }

    async deleteRecord(id: string): Promise<void> {
        await patientMedicalRecordRepository.delete(id);
    }
}

export const patientMedicalRecordService = new PatientMedicalRecordService();
