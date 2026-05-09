import { AppDataSource } from "../../config/database.js";
import { PatientVerification } from "../../models/Appointments/patient-verification.model.js";

export class PatientVerificationRepository {
    private repo = AppDataSource.getRepository(PatientVerification);

    async findByAppointmentId(appointmentId: number): Promise<PatientVerification | null> {
        return await this.repo.findOne({
            where: { AppointmentId: appointmentId },
            relations: ["Appointment", "Verifier"]
        });
    }

    async save(data: Partial<PatientVerification>): Promise<PatientVerification> {
        const verification = this.repo.create(data);
        return await this.repo.save(verification);
    }

    async updateStatus(appointmentId: number, updateData: Partial<PatientVerification>): Promise<void> {
        await this.repo.update({ AppointmentId: appointmentId }, { 
            ...updateData, 
            UpdatedAt: new Date() 
        });
    }

    async upsert(appointmentId: number, data: Partial<PatientVerification>): Promise<PatientVerification> {
        const existing = await this.findByAppointmentId(appointmentId);
        if (existing) {
            await this.repo.update({ AppointmentId: appointmentId }, { ...data, UpdatedAt: new Date() });
            return (await this.findByAppointmentId(appointmentId))!;
        } else {
            const newItem = this.repo.create({ ...data, AppointmentId: appointmentId });
            return await this.repo.save(newItem);
        }
    }
}

export const patientVerificationRepository = new PatientVerificationRepository();
