import { patientSummaryRepository } from "../../repositories/Appointments/patient-summary.repository.js";

export class PatientSummaryService {
    async getPatientSummary(patientId: string, orgId?: number, hospitalId?: number) {
        return await patientSummaryRepository.getPatientSummary(patientId, orgId, hospitalId);
    }
}

export const patientSummaryService = new PatientSummaryService();
