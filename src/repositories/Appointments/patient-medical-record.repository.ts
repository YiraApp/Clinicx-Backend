import { AppDataSource } from "../../config/database.js";
import { PatientMedicalRecord } from "../../models/Appointments/patient-medical-record.model.js";

export class PatientMedicalRecordRepository {
    private repo = AppDataSource.getRepository(PatientMedicalRecord);

    async create(data: Partial<PatientMedicalRecord>): Promise<PatientMedicalRecord> {
        const record = this.repo.create(data);
        return await this.repo.save(record);
    }

    async findByPatient(patientId: string, orgId?: number, hospitalId?: number, appointmentId?: number): Promise<PatientMedicalRecord[]> {
        const where: any = { PatientId: patientId };
        if (orgId) where.OrganizationId = orgId;
        if (hospitalId) where.HospitalId = hospitalId;
        if (appointmentId) where.AppointmentId = appointmentId;

        return await this.repo.find({
            where,
            relations: ["Doctor", "Appointment"],
            order: { CreatedAt: "DESC" }
        });
    }

    async findById(id: string): Promise<PatientMedicalRecord | null> {
        return await this.repo.findOne({
            where: { Id: id },
            relations: ["Doctor", "Patient", "Appointment"]
        });
    }

    async update(id: string, data: Partial<PatientMedicalRecord>): Promise<void> {
        await this.repo.update(id, { ...data, UpdatedAt: new Date() });
    }

    async delete(id: string): Promise<void> {
        await this.repo.delete(id);
    }
}

export const patientMedicalRecordRepository = new PatientMedicalRecordRepository();
