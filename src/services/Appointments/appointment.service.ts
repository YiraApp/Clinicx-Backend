import { AppDataSource } from "../../config/database.js";
import { appointmentRepository } from "../../repositories/Appointments/appointment.repository.js";
import { healthcareProviderScheduleSlotRepository } from "../../repositories/Organizations/healthcare-provider-schedule-slot.repository.js";
import { patientQueueRepository } from "../../repositories/Appointments/patient-queue.repository.js";
import { Appointment } from "../../models/Appointments/appointment.model.js";
import { PatientQueue } from "../../models/Appointments/patient-queue.model.js";
import { AppointmentStatus, QueueStatus } from "../../enums/appointments.js";

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
        isTeleConsultation?: boolean;
    }): Promise<Appointment> {
        return await AppDataSource.transaction(async (manager) => {
            // 1. Check if slot exists and is available
            const slot = await healthcareProviderScheduleSlotRepository.findById(data.slotId);
            if (!slot) throw new Error("Slot not found.");
            if (slot.IsBooked) throw new Error("Slot is already booked.");
            if (!slot.IsAvailable) throw new Error("Slot is blocked.");

            // 2. Generate Meeting URL if teleconsultation
            let meetingUrl: string | undefined = undefined;
            if (data.isTeleConsultation) {
                // Generate a simple meeting ID
                const meetingId = Math.random().toString(36).substring(2, 12);
                meetingUrl = `/teleconsult/${meetingId}`;
            }

            // 3. Generate Appointment Number
            const appointmentDate = new Date(data.appointmentDate);
            const appointmentNumber = await appointmentRepository.getNextAppointmentNumber(
                data.hospitalId,
                appointmentDate
            );

            // 4. Create Appointment
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
                IsTeleConsultation: data.isTeleConsultation || false,
                MeetingUrl: meetingUrl,
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
        return await appointmentRepository.getDoctorAppointments(doctorId, dateStr);
    }

    async getHospitalAppointments(hospitalId: number, dateStr: string) {
        return await appointmentRepository.getHospitalAppointments(hospitalId, dateStr);
    }

    async getPatientAppointments(userId: string) {
        return await appointmentRepository.getPatientAppointments(userId);
    }

    async getAppointments(filters: { orgId?: number, hospitalId?: number, userId?: string, date?: string, status?: string }) {
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
        return await AppDataSource.transaction(async (manager) => {
            // Update appointment status
            await manager.update(Appointment, appointmentId, { Status: status, UpdatedAt: new Date() });

            const statusLower = status.toLowerCase();

            // If status is "Arrived", add to queue if not already there
            if (statusLower === AppointmentStatus.Arrived.toLowerCase()) {
                const existingQueue = await manager.findOne(PatientQueue, { where: { AppointmentId: appointmentId } });
                if (!existingQueue) {
                    const appointment = await manager.findOne(Appointment, { 
                        where: { Id: appointmentId },
                        relations: ["Hospital"]
                    });
                    
                    if (appointment) {
                        const nextNumber = await patientQueueRepository.getNextQueueNumber(appointment.HospitalId, new Date());
                        const newQueueEntry = manager.create(PatientQueue, {
                            AppointmentId: appointmentId,
                            DoctorId: appointment.DoctorId,
                            QueueNumber: nextNumber,
                            Status: QueueStatus.Waiting,
                            AddedAt: new Date()
                        });
                        await manager.save(newQueueEntry);
                    }
                }
            }

            // If status is "In Progress", update queue status to "WithDoctor"
            if (statusLower === AppointmentStatus.InProgress.toLowerCase()) {
                const queueEntry = await manager.findOne(PatientQueue, { where: { AppointmentId: appointmentId } });
                if (queueEntry) {
                    await manager.update(PatientQueue, queueEntry.Id, { 
                        Status: QueueStatus.WithDoctor,
                        CalledAt: new Date()
                    });
                }
            }

            // If status is "Completed", update queue status
            if (statusLower === AppointmentStatus.Completed.toLowerCase()) {
                const queueEntry = await manager.findOne(PatientQueue, { where: { AppointmentId: appointmentId } });
                if (queueEntry) {
                    await manager.update(PatientQueue, queueEntry.Id, { 
                        Status: QueueStatus.Completed,
                        CompletedAt: new Date()
                    });
                }
            }

            // If status is "Cancelled", update queue status
            if (statusLower === AppointmentStatus.Cancelled.toLowerCase()) {
                const queueEntry = await manager.findOne(PatientQueue, { where: { AppointmentId: appointmentId } });
                if (queueEntry) {
                    await manager.update(PatientQueue, queueEntry.Id, { 
                        Status: QueueStatus.Skipped
                    });
                }
            }
        });
    }
}

export const appointmentService = new AppointmentService();

