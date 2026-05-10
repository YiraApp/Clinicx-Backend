import { AppDataSource } from "../../config/database.js";
import { PatientPrescription } from "../../models/Appointments/patient-prescription.model.js";

export class PatientPrescriptionRepository {
    private repo = AppDataSource.getRepository(PatientPrescription);

    async create(data: Partial<PatientPrescription>): Promise<PatientPrescription> {
        const record = this.repo.create(data);
        return await this.repo.save(record);
    }

    async findByPatient(patientId: string, orgId?: number, hospitalId?: number, appointmentId?: string): Promise<PatientPrescription[]> {
        const where: any = { PatientId: patientId };
        if (orgId) where.OrganizationId = orgId;
        if (hospitalId) where.HospitalId = hospitalId;
        if (appointmentId) where.AppointmentId = appointmentId;

        return await this.repo.find({
            where,
            order: { CreatedAt: "DESC" }
        });
    }

    async findById(id: string): Promise<PatientPrescription | null> {
        return await this.repo.findOne({
            where: { Id: id }
        });
    }

    async update(id: string, data: Partial<PatientPrescription>): Promise<void> {
        await this.repo.update(id, { ...data, UpdatedAt: new Date() });
    }

    async delete(id: string): Promise<void> {
        await this.repo.delete(id);
    }
}

export const patientPrescriptionRepository = new PatientPrescriptionRepository();
