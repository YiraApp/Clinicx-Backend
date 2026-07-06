import { AppDataSource } from "../../config/database.js";
import { appointmentRepository } from "../../repositories/Appointments/appointment.repository.js";
import { healthcareProviderScheduleSlotRepository } from "../../repositories/Organizations/healthcare-provider-schedule-slot.repository.js";
import { patientQueueRepository } from "../../repositories/Appointments/patient-queue.repository.js";
import { Appointment } from "../../models/Appointments/appointment.model.js";
import { PatientQueue } from "../../models/Appointments/patient-queue.model.js";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import { PatientInsurance } from "../../models/Organizations/patient-insurance.model.js";
import { AppointmentStatus, QueueStatus } from "../../enums/appointments.js";
import { appointmentBillRepository } from "../../repositories/Payments/appointment-bill.repository.js";

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
        parentAppointmentId?: number | null;
        treatmentPlanIds?: string[];
        customTreatmentPlans?: { name: string; amount: number; description?: string }[];
        discountAmount?: number;
    }): Promise<Appointment> {

        const newAppointment = await AppDataSource.transaction(async (manager) => {
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
                ParentAppointmentId: data.parentAppointmentId || null,

                MeetingUrl: meetingUrl,
                CreatedBy: data.createdBy,
                AppointmentNumber: appointmentNumber
            });

            // 5. Link Treatment Plans
            if (data.treatmentPlanIds && data.treatmentPlanIds.length > 0) {
                const { AppointmentTreatmentPlan } = await import("../../models/Payments/appointment-treatment-plan.model.js");
                const { v4: uuidv4 } = await import("uuid");
                for (const planId of data.treatmentPlanIds) {
                    const link = manager.create(AppointmentTreatmentPlan, {
                        AppointmentTreatmentPlanId: uuidv4(),
                        AppointmentId: appointment.Id,
                        TreatmentPlanId: planId,
                        CreatedAt: new Date()
                    });
                    await manager.save(link);
                }
            }

            // 5.5. Create & Link Custom Treatment Plans
            if (data.customTreatmentPlans && data.customTreatmentPlans.length > 0) {
                const { TreatmentPlan } = await import("../../models/Payments/treatment-plan.model.js");
                const { AppointmentTreatmentPlan } = await import("../../models/Payments/appointment-treatment-plan.model.js");
                const { v4: uuidv4 } = await import("uuid");
                for (const customPlan of data.customTreatmentPlans) {
                    if (!customPlan.name) continue;
                    const newPlan = manager.create(TreatmentPlan, {
                        TreatmentPlanId: uuidv4(),
                        Name: customPlan.name,
                        Description: customPlan.description || null,
                        Amount: Number(customPlan.amount || 0),
                        Status: "Active",
                        OrgId: data.orgId,
                        HospitalId: data.hospitalId,
                        IsDeleted: false,
                        CreatedAt: new Date()
                    });
                    await manager.save(newPlan);

                    const link = manager.create(AppointmentTreatmentPlan, {
                        AppointmentTreatmentPlanId: uuidv4(),
                        AppointmentId: appointment.Id,
                        TreatmentPlanId: newPlan.TreatmentPlanId,
                        CreatedAt: new Date()
                    });
                    await manager.save(link);
                }
            }

            // 6. Mark Slot as Booked
            await manager.update("HealthcareProviderScheduleSlots", data.slotId, {
                IsBooked: true,
                Status: "Booked",
                UpdatedAt: new Date()
            });

            // 7. Create/consolidate complete Appointment Bill immediately
            const { HealthcareProvider } = await import("../../models/Organizations/healthcare-provider.model.js");
            const provider = await manager.findOne(HealthcareProvider, {
                where: { UserId: data.doctorId }
            });
            const consultationFee = data.appointmentType === "Without Consultation" ? 0 : (provider?.ConsultationFee || 0);

            // If it's a follow-up, locate the root parent appointment in the chain
            let rootParentId: number | null = null;
            if (appointment.ParentAppointmentId) {
                const { Appointment: ApptModel } = await import("../../models/Appointments/appointment.model.js");
                 let currentId = appointment.ParentAppointmentId;
                 const visitedAppts = new Set<number>();
                 while (currentId) {
                     if (visitedAppts.has(currentId)) {
                         break;
                     }
                     visitedAppts.add(currentId);
                     const parentAppt = await manager.findOne(ApptModel, { where: { Id: currentId } });
                     if (parentAppt) {
                         rootParentId = parentAppt.Id;
                         currentId = parentAppt.ParentAppointmentId || 0;
                     } else {
                         break;
                     }
                 }
            }

            let billAppended = false;
            if (rootParentId) {
                const parentBill = await appointmentBillRepository.findByAppointmentId(rootParentId);
                if (parentBill) {
                    await appointmentBillRepository.appendChildItemsToBill(parentBill.AppointmentBillId, appointment.Id, {
                        consultationFee,
                        treatmentPlanIds: data.treatmentPlanIds || [],
                        customTreatmentPlans: data.customTreatmentPlans || [],
                        discountAmount: data.discountAmount || 0
                    });
                    billAppended = true;
                }
            }

            if (!billAppended) {
                await appointmentBillRepository.createBillForAppointment(appointment.Id, {
                    patientId: data.userId,
                    providerId: data.doctorId,
                    hospitalId: data.hospitalId,
                    consultationFee,
                    treatmentPlanIds: data.treatmentPlanIds || [],
                    customTreatmentPlans: data.customTreatmentPlans || [],
                    discountAmount: data.discountAmount || 0
                });
            }

            return appointment;
        });

        // Async task: create meeting redirection and send WhatsApp confirmation
        try {
            const enrichedAppointment = await appointmentRepository.findById(newAppointment.Id);
            if (enrichedAppointment && enrichedAppointment.User?.PhoneNumber) {
                const appt = enrichedAppointment;
                const { meetingRedirectionService } = await import("./meeting-redirection.service.js");
                const { whatsappService } = await import("../Common/whatsapp.service.js");

                // 1. Create a MeetingRedirection record
                const redirection = await meetingRedirectionService.createRedirection({
                    AppointmentId: appt.Id,
                    PatientId: appt.UserId,
                    DoctorId: appt.DoctorId,
                    HospitalId: appt.HospitalId,
                    OrganizationId: appt.OrgId,
                    MeetingUrl: appt.MeetingUrl || "",
                    AppointmentDate: appt.AppointmentDate,
                    StartTime: appt.StartTime
                });

                // 2. Format details for WhatsApp
                const patientName = `${appt.User?.FirstName || ""} ${appt.User?.LastName || ""}`.trim();
                const doctorName = appt.Doctor 
                    ? `${appt.Doctor.FirstName || ""} ${appt.Doctor.LastName || ""}`.trim()
                    : "N/A";
                const hospitalName = appt.Hospital?.Name || "our clinic";

                const dateStr = new Date(appt.AppointmentDate).toLocaleDateString("en-IN", {
                    day: "2-digit", month: "short", year: "numeric"
                });
                const timeStr = appt.StartTime ? appt.StartTime.slice(0, 5) : "";

                const countryCode = appt.User.CountryCode || "91";
                const normalizedPhone = `${countryCode.replace(/\D/g, "")}${appt.User.PhoneNumber.replace(/\D/g, "")}`;

                // 3. Select the template based on consultation type
                const templateName = appt.IsTeleConsultation ? "video_call_template" : "appointment_conformation";

                const components: any[] = [
                    {
                        type: "header",
                        parameters: [
                            { type: "text", text: hospitalName }
                        ]
                    }
                ];

                const bodyParameters = [
                    { type: "text", text: patientName },
                    { type: "text", text: doctorName },
                    { type: "text", text: hospitalName },
                    { type: "text", text: dateStr },
                    { type: "text", text: timeStr }
                ];

                components.push({
                    type: "body",
                    parameters: bodyParameters
                });

                if (appt.IsTeleConsultation) {
                    components.push({
                        type: "button",
                        sub_type: "url",
                        index: "0",
                        parameters: [
                            { type: "text", text: redirection.UrlId }
                        ]
                    });
                }

                await whatsappService.sendTemplateMessage(normalizedPhone, templateName, "en", components);
                console.log(`[AppointmentService] WhatsApp appointment notification sent to ${normalizedPhone} using template ${templateName}`);
            }
        } catch (err) {
            console.error("[AppointmentService] Error generating redirection or sending WhatsApp notification:", err);
        }

        return newAppointment;
    }

    async attachMedicalAndInsurance(appointments: Appointment[]) {
        const userIds = [...new Set(appointments.map(a => a.UserId).filter(Boolean))];
        const appointmentIds = appointments.map(a => a.Id).filter(Boolean);
        const medicalMap = new Map<string, PatientRegistration>();
        const insuranceMap = new Map<string, PatientInsurance>();
        const plansMap = new Map<number, any[]>();

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

        if (appointmentIds.length > 0) {
            try {
                const { AppointmentTreatmentPlan } = await import("../../models/Payments/appointment-treatment-plan.model.js");
                const links = await AppDataSource.getRepository(AppointmentTreatmentPlan)
                    .createQueryBuilder("atp")
                    .leftJoinAndSelect("atp.TreatmentPlan", "tp")
                    .where("atp.AppointmentId IN (:...appointmentIds)", { appointmentIds })
                    .getMany();

                links.forEach(link => {
                    if (link.TreatmentPlan) {
                        const arr = plansMap.get(link.AppointmentId) || [];
                        arr.push(link.TreatmentPlan);
                        plansMap.set(link.AppointmentId, arr);
                    }
                });
            } catch (error) {
                console.error("Error attaching treatment plans:", error);
            }
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
                treatmentPlans: plansMap.get(apt.Id) || []
            };
        });
    }

    async getDoctorAppointments(doctorId: string, dateStr: string, orgId?: number, hospitalId?: number) {
        return await appointmentRepository.getDoctorAppointments(doctorId, dateStr, orgId, hospitalId);
    }

    async getHospitalAppointments(hospitalId: number, dateStr: string) {
        return await appointmentRepository.getHospitalAppointments(hospitalId, dateStr);
    }

    async getPatientAppointments(userId: string) {
        const appointments = await appointmentRepository.getPatientAppointments(userId);
        const enrichedAppointments = [];
        const { HealthcareProvider } = await import("../../models/Organizations/healthcare-provider.model.js");

        for (const appt of appointments) {
            let specialty = "General Medicine";
            if (appt.DoctorId) {
                const provider = await AppDataSource.getRepository(HealthcareProvider).findOne({
                    where: { UserId: appt.DoctorId, IsDeleted: false }
                });
                if (provider) {
                    specialty = provider.Specialty || "General Medicine";
                }
            }
            enrichedAppointments.push({
                ...appt,
                specialty
            });
        }

        return await this.attachMedicalAndInsurance(enrichedAppointments);
    }

    async getPatientHospitalSummary(userId: string) {
        const hospitals = await appointmentRepository.getPatientHospitalSummary(userId);
        
        const allUserAppointments = await AppDataSource.getRepository(Appointment).find({
            where: { UserId: userId },
            select: ["Id", "Status"]
        });

        const stats = {
            total: allUserAppointments.length,
            confirmed: 0,
            pending: 0,
            completed: 0
        };

        for (const apt of allUserAppointments) {
            const s = apt.Status?.toLowerCase() || "";
            if (s === "confirmed" || s === "scheduled") stats.confirmed++;
            else if (s === "pending" || s === "paymentpending") stats.pending++;
            else if (s === "completed") stats.completed++;
        }

        return {
            hospitals,
            stats
        };
    }

    async getPatientAppointmentsByHospital(userId: string, hospitalId: number) {
        const appointments = await appointmentRepository.getPatientAppointmentsByHospital(userId, hospitalId);
        const enrichedAppointments = [];
        const { HealthcareProvider } = await import("../../models/Organizations/healthcare-provider.model.js");

        for (const appt of appointments) {
            let specialty = "General Medicine";
            if (appt.DoctorId) {
                const provider = await AppDataSource.getRepository(HealthcareProvider).findOne({
                    where: { UserId: appt.DoctorId, IsDeleted: false }
                });
                if (provider) {
                    specialty = provider.Specialty || "General Medicine";
                }
            }
            enrichedAppointments.push({
                ...appt,
                specialty
            });
        }

        return await this.attachMedicalAndInsurance(enrichedAppointments);
    }

    async getAppointments(filters: { orgId?: number, hospitalId?: number, userId?: string, doctorId?: string, date?: string, status?: string, startDate?: string, endDate?: string, page?: number, pageSize?: number }) {
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

