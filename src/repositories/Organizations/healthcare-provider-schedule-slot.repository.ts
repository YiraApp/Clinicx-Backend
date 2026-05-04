import { AppDataSource } from "../../config/database.js";
import { HealthcareProviderScheduleSlot } from "../../models/Organizations/healthcare-provider-schedule-slot.model.js";
import { Between } from "typeorm/index.js";

export class HealthcareProviderScheduleSlotRepository {
    private repo = AppDataSource.getRepository(HealthcareProviderScheduleSlot);

    async getSlots(providerId: number, hospitalId: number, startDate: Date, endDate: Date): Promise<HealthcareProviderScheduleSlot[]> {
        return await this.repo.find({
            where: {
                ProviderId: providerId,
                HospitalId: hospitalId,
                SlotDate: Between(startDate, endDate),
                IsDeleted: false
            },
            order: {
                SlotDate: "ASC",
                StartTime: "ASC"
            }
        });
    }

    async saveSlots(slots: HealthcareProviderScheduleSlot[]): Promise<HealthcareProviderScheduleSlot[]> {
        return await this.repo.save(slots);
    }

    async deleteSlotsForDateRange(providerId: number, hospitalId: number, startDate: Date, endDate: Date): Promise<void> {
        await this.repo.update(
            {
                ProviderId: providerId,
                HospitalId: hospitalId,
                SlotDate: Between(startDate, endDate)
            },
            { IsDeleted: true, UpdatedAt: new Date() }
        );
    }

    async findByDateAndTimes(providerId: number, hospitalId: number, date: Date, startTime: string, endTime: string): Promise<HealthcareProviderScheduleSlot | null> {
        return await this.repo.findOne({
            where: {
                ProviderId: providerId,
                HospitalId: hospitalId,
                SlotDate: date,
                StartTime: startTime,
                EndTime: endTime,
                IsDeleted: false
            }
        });
    }
}

export const healthcareProviderScheduleSlotRepository = new HealthcareProviderScheduleSlotRepository();
