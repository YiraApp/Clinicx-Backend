import { AppDataSource } from "../../config/database.js";
import { HealthcareProviderScheduleSlot } from "../../models/Organizations/healthcare-provider-schedule-slot.model.js";
import { Between } from "typeorm/index.js";

export class HealthcareProviderScheduleSlotRepository {
    private repo = AppDataSource.getRepository(HealthcareProviderScheduleSlot);

    async getSlots(providerId: number, hospitalId: number, startDate: Date, endDate: Date): Promise<HealthcareProviderScheduleSlot[]> {
        const slots = await this.repo.find({
            where: {
                ProviderId: providerId,
                HospitalId: hospitalId,
                SlotDate: Between(startDate, endDate),
                IsDeleted: false
            },
            relations: ["Appointments", "Appointments.User"],
            order: {
                SlotDate: "ASC",
                StartTime: "ASC"
            }
        });

        for (const slot of slots) {
            if (slot.IsBooked) {
                const hasActiveAppointment = slot.Appointments && slot.Appointments.some(appt => 
                    appt.Status && !["cancelled", "canceled", "no show", "noshow", "rescheduled"].includes(appt.Status.toLowerCase())
                );
                if (!hasActiveAppointment) {
                    slot.IsBooked = false;
                    if (slot.Status === "Booked") {
                        slot.Status = "Available";
                    }
                }
            }
        }
        return slots;
    }

    async findById(id: number): Promise<HealthcareProviderScheduleSlot | null> {
        const slot = await this.repo.findOne({ 
            where: { Id: id, IsDeleted: false },
            relations: ["Appointments", "Appointments.User"]
        });

        if (slot && slot.IsBooked) {
            const hasActiveAppointment = slot.Appointments && slot.Appointments.some(appt => 
                appt.Status && !["cancelled", "canceled", "no show", "noshow", "rescheduled"].includes(appt.Status.toLowerCase())
            );
            if (!hasActiveAppointment) {
                slot.IsBooked = false;
                if (slot.Status === "Booked") {
                    slot.Status = "Available";
                }
            }
        }
        return slot;
    }

    async saveSlots(slots: HealthcareProviderScheduleSlot[]): Promise<HealthcareProviderScheduleSlot[]> {
        return await this.repo.save(slots);
    }

    async findExistingSlots(providerId: number, hospitalId: number, startDate: Date, endDate: Date): Promise<Set<string>> {
        const slots = await this.repo.find({
            where: {
                ProviderId: providerId,
                HospitalId: hospitalId,
                SlotDate: Between(startDate, endDate),
                IsDeleted: false
            },
            select: ["SlotDate", "StartTime", "EndTime"]
        });
        // Normalize SlotDate to YYYY-MM-DD regardless of how DB returns it
        return new Set(slots.map(s => {
            const d = s.SlotDate instanceof Date
                ? s.SlotDate.toISOString().split('T')[0]
                : String(s.SlotDate).split('T')[0];
            return `${d}|${s.StartTime}|${s.EndTime}`;
        }));
    }

    async deleteUnbookedSlotsForDateRange(providerId: number, hospitalId: number, startDate: Date, endDate: Date): Promise<number> {
        const result = await this.repo.update(
            {
                ProviderId: providerId,
                HospitalId: hospitalId,
                SlotDate: Between(startDate, endDate),
                IsBooked: false,
                IsDeleted: false
            },
            { IsDeleted: true, UpdatedAt: new Date() }
        );
        return result.affected || 0;
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

    async updateSlotStatus(id: number, data: { status?: string, isAvailable?: boolean }): Promise<HealthcareProviderScheduleSlot | null> {
        const slot = await this.repo.findOneBy({ Id: id, IsDeleted: false });
        if (!slot) return null;

        if (data.status !== undefined) slot.Status = data.status;
        if (data.isAvailable !== undefined) slot.IsAvailable = data.isAvailable;
        
        try {
            await this.repo.update(id, {
                Status: slot.Status,
                IsAvailable: slot.IsAvailable,
                UpdatedAt: new Date()
            });
            return await this.repo.findOneBy({ Id: id });
        } catch (error) {
            console.error(`[Repository] updateSlotStatus - UPDATE ERROR:`, error);
            throw error;
        }
    }
}

export const healthcareProviderScheduleSlotRepository = new HealthcareProviderScheduleSlotRepository();
