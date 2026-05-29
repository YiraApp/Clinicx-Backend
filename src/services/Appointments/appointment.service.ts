import { AppDataSource } from "../../config/database.js";
import { appointmentRepository } from "../../repositories/Appointments/appointment.repository.js";
import { healthcareProviderScheduleSlotRepository } from "../../repositories/Organizations/healthcare-provider-schedule-slot.repository.js";
import { patientQueueRepository } from "../../repositories/Appointments/patient-queue.repository.js";
import { Appointment } from "../../models/Appointments/appointment.model.js";
import { PatientQueue } from "../../models/Appointments/patient-queue.model.js";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import { PatientInsurance } from "../../models/Organizations/patient-insurance.model.js";
import { AppointmentStatus, QueueStatus } from "../../enums/appointments.js";

import { zoomService } from "../Common/zoom.service.js";

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
        status?: string;
    }): Promise<Appointment> {

        return await AppDataSource.transaction(async (manager) => {
            // 1. Check if slot exists and is available
            const slot = await healthcareProviderScheduleSlotRepository.findById(data.slotId);
            if (!slot) throw new Error("Slot not found.");
            if (slot.IsBooked) throw new Error("Slot is already booked.");
            if (!slot.IsAvailable) throw new Error("Slot is blocked.");

            // 2. Generate Meeting URL if teleconsultation
            let meetingUrl: string | undefined = undefined;
            const isTele = data.isTeleConsultation || data.appointmentType === "Teleconsult" || data.appointmentType === "TeleConsultation";
            if (isTele) {
                const appointmentDate = new Date(data.appointmentDate);
                const zoomMeeting = await zoomService.createMeeting(
                    `Consultation: ${data.reason || 'General'}`,
                    appointmentDate
                );
                meetingUrl = zoomMeeting.join_url;
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
                Status: data.status || "Scheduled",
                IsTeleConsultation: isTele,

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

    async attachMedicalAndInsurance(appointments: Appointment[]) {
        const userIds = [...new Set(appointments.map(a => a.UserId).filter(Boolean))];
        const medicalMap = new Map<string, PatientRegistration>();
        const insuranceMap = new Map<string, PatientInsurance>();

        if (userIds.length > 0) {
            const registrations = await AppDataSource.getRepository(PatientRegistration)
                .createQueryBuilder("pr")
                .where("pr.UserId IN (:...userIds)", { userIds })
                .andWhere("pr.IsDeleted = :deleted", { deleted: false })
                .getMany();
            registrations.forEach(reg => medicalMap.set(reg.UserId.toUpperCase(), reg));

            const insurances = await AppDataSource.getRepository(PatientInsurance)
                .createQueryBuilder("ins")
                .where("ins.UserId IN (:...userIds)", { userIds })
                .andWhere("ins.IsDeleted = :deleted", { deleted: false })
                .getMany();
            insurances.forEach(ins => insuranceMap.set(ins.UserId.toUpperCase(), ins));
        }

        return appointments.map(apt => {
            const reg = medicalMap.get(apt.UserId?.toUpperCase());
            const ins = insuranceMap.get(apt.UserId?.toUpperCase());
            return {
                ...apt,
                allergies: reg?.Allergies || null,
                medicalHistory: reg?.MedicalHistory || null,
                insuranceProvider: ins?.InsuranceProvider || null,
                insuranceNumber: ins?.InsuranceNumber || null,
            };
        });
    }

    async getDoctorAppointments(doctorId: string, dateStr: string) {
        return await appointmentRepository.getDoctorAppointments(doctorId, dateStr);
    }

    async getHospitalAppointments(hospitalId: number, dateStr: string) {
        return await appointmentRepository.getHospitalAppointments(hospitalId, dateStr);
    }

    async getPatientAppointments(userId: string) {
        const appointments = await appointmentRepository.getPatientAppointments(userId);
        return await this.attachMedicalAndInsurance(appointments);
    }

    async getAppointments(filters: { orgId?: number, hospitalId?: number, userId?: string, date?: string, status?: string, startDate?: string, endDate?: string, page?: number, pageSize?: number }) {
        const { data: appointments, total } = await appointmentRepository.getAppointments(filters);
        const enriched = await this.attachMedicalAndInsurance(appointments);
        const summary = {
            totalAppointments: appointments.length,
            totalScheduled: 0,
            totalConfirmed: 0,
            totalPaymentPending: 0,
            totalCompleted: 0
        };
        for (const apt of appointments) {
            const s = apt.Status?.toLowerCase() || "";
            if (s === "scheduled") summary.totalScheduled++;
            else if (s === "confirmed") summary.totalConfirmed++;
            else if (s === "paymentpending") summary.totalPaymentPending++;
            else if (s === "completed") summary.totalCompleted++;
        }
        return { data: enriched, summary, total, page: filters.page || 1, pageSize: filters.pageSize || 50 };
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
    async createInstantMeeting(topic: string = "Instant Consultation") {
        return await zoomService.createMeeting(topic);
    }
}

export const appointmentService = new AppointmentService();

