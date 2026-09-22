import { AppDataSource } from "../../config/database.js";
import { PatientMedicationReminder } from "../../models/Appointments/patient-medication-reminder.model.js";

export class PatientMedicationReminderRepository {
    private get repo() {
        return AppDataSource.getRepository(PatientMedicationReminder);
    }

    async saveReminder(data: Partial<PatientMedicationReminder>): Promise<PatientMedicationReminder> {
        return await this.repo.save(data as PatientMedicationReminder);
    }

    async findActiveByUserId(userId: string): Promise<PatientMedicationReminder[]> {
        return await this.repo.find({
            where: { UserId: userId, IsActive: true },
            order: { CreatedAt: "DESC" }
        });
    }

    async findById(id: string): Promise<PatientMedicationReminder | null> {
        return await this.repo.findOne({ where: { Id: id } });
    }

    async deactivateReminder(id: string, userId: string): Promise<boolean> {
        const result = await this.repo.update({ Id: id, UserId: userId }, { IsActive: false, UpdatedAt: new Date() });
        return (result.affected ?? 0) > 0;
    }

    async deleteReminder(id: string, userId: string): Promise<boolean> {
        const result = await this.repo.delete({ Id: id, UserId: userId });
        return (result.affected ?? 0) > 0;
    }
}

export const patientMedicationReminderRepository = new PatientMedicationReminderRepository();
