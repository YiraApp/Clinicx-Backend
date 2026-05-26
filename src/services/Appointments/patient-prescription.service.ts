import { patientPrescriptionRepository } from "../../repositories/Appointments/patient-prescription.repository.js";
import { PatientPrescription } from "../../models/Appointments/patient-prescription.model.js";

export class PatientPrescriptionService {
    async addPrescription(data: Partial<PatientPrescription>): Promise<PatientPrescription> {
        return await patientPrescriptionRepository.create(data);
    }

    async getPatientPrescriptions(patientId: string, orgId?: number, hospitalId?: number, appointmentId?: string): Promise<PatientPrescription[]> {
        return await patientPrescriptionRepository.findByPatient(patientId, orgId, hospitalId, appointmentId);
    }

    async getPrescriptionById(id: string): Promise<PatientPrescription | null> {
        return await patientPrescriptionRepository.findById(id);
    }

    async getPrescriptionsByAppointment(appointmentId: string, orgId?: number, hospitalId?: number): Promise<PatientPrescription[]> {
        return await patientPrescriptionRepository.findByAppointment(appointmentId, orgId, hospitalId);
    }

    async updatePrescription(id: string, data: Partial<PatientPrescription>): Promise<void> {
        await patientPrescriptionRepository.update(id, data);
    }

    async deletePrescription(id: string): Promise<void> {
        await patientPrescriptionRepository.delete(id);
    }
}

export const patientPrescriptionService = new PatientPrescriptionService();
