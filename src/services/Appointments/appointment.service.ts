import { AppDataSource } from "../../config/database.js";
import { appointmentRepository } from "../../repositories/Appointments/appointment.repository.js";
import { healthcareProviderScheduleSlotRepository } from "../../repositories/Organizations/healthcare-provider-schedule-slot.repository.js";
import { Appointment } from "../../models/Appointments/appointment.model.js";

export class AppointmentService {
    async bookAppointment(data: {
        userId: string;
        doctorId: string;
        hospitalId: number;
        orgId: number;
        slotId: number;
        appointmentDate: string;
        startTime: string;
        endTime: string;
        reason?: string;
        appointmentType?: string;
        createdBy?: string;
    }): Promise<Appointment> {
        return await AppDataSource.transaction(async (manager) => {
            // 1. Check if slot exists and is available
            const slot = await healthcareProviderScheduleSlotRepository.findById(data.slotId);
            if (!slot) throw new Error("Slot not found.");
            if (slot.IsBooked) throw new Error("Slot is already booked.");
            if (!slot.IsAvailable) throw new Error("Slot is blocked.");

            // 2. Generate Appointment Number
            const appointmentDate = new Date(data.appointmentDate);
            const appointmentNumber = await appointmentRepository.getNextAppointmentNumber(
                data.hospitalId,
                data.doctorId,
                appointmentDate
            );

            // 3. Create Appointment
            const appointment = await appointmentRepository.create({
                UserId: data.userId,
                DoctorId: data.doctorId,
                HospitalId: data.hospitalId,
                OrgId: data.orgId,
                SlotId: data.slotId,
                AppointmentDate: appointmentDate,
                StartTime: data.startTime,
                EndTime: data.endTime,
                Reason: data.reason,
                AppointmentType: data.appointmentType || "Consultation",
                Status: "Scheduled",
                CreatedBy: data.createdBy,
                AppointmentNumber: appointmentNumber
            });

            // 3. Mark Slot as Booked
            await manager.update("HealthcareProviderScheduleSlots", data.slotId, {
                IsBooked: true,
                Status: "Booked",
                UpdatedAt: new Date()
            });

            return appointment;
        });
    }

    async getDoctorAppointments(doctorId: string, dateStr: string) {
        const date = new Date(dateStr);
        return await appointmentRepository.getDoctorAppointments(doctorId, date);
    }

    async getHospitalAppointments(hospitalId: number, dateStr: string) {
        const date = new Date(dateStr);
        return await appointmentRepository.getHospitalAppointments(hospitalId, date);
    }

    async getPatientAppointments(userId: string) {
        return await appointmentRepository.getPatientAppointments(userId);
    }

    async getAppointments(filters: { orgId?: number, hospitalId?: number, date?: string, status?: string }) {
        return await appointmentRepository.getAppointments(filters);
    }

    async cancelAppointment(appointmentId: number, slotId: number) {
        return await AppDataSource.transaction(async (manager) => {
            await manager.update("Appointments", appointmentId, {
                Status: "Cancelled",
                UpdatedAt: new Date()
            });

            await manager.update("HealthcareProviderScheduleSlots", slotId, {
                IsBooked: false,
                Status: "Available",
                UpdatedAt: new Date()
            });
        });
    }

    async updateAppointmentStatus(appointmentId: number, status: string) {
        return await appointmentRepository.updateStatus(appointmentId, status);
    }
}

export const appointmentService = new AppointmentService();
