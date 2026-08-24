import { AppDataSource } from "../../../../config/database.js";
import { Appointment } from "../../../../models/Appointments/appointment.model.js";
import { User } from "../../../../models/Account/user.model.js";
import { UserRole } from "../../../../models/Account/userrole.model.js";
import { Role } from "../../../../models/Account/role.model.js";
import { PatientRegistration } from "../../../../models/Organizations/patient-registration.model.js";
import { Hospital } from "../../../../models/Organizations/hospital.model.js";
import { HealthcareProviderScheduleSlot } from "../../../../models/Organizations/healthcare-provider-schedule-slot.model.js";
import { healthcareProviderRepository } from "../../../../repositories/Organizations/healthcare-provider.repository.js";
import { pushNotificationService } from "../../../../services/Notifications/push-notification.service.js";
import { whatsappService } from "../../../../services/Common/whatsapp.service.js";
import { zoomService } from "../../../../services/Common/zoom.service.js";
import { v4 as uuidv4 } from "uuid";

export class MobileAppointmentService {
    async getAppointmentDashboard(
        doctorId: string,
        hospitalId: number,
        orgId: number,
        options?: { date?: string; dateFrom?: string; dateTo?: string; status?: string; search?: string }
    ): Promise<any> {
        const appointmentRepo = AppDataSource.getRepository(Appointment);

        const todayStr = options?.date || new Date().toISOString().split("T")[0];

        // 1. Calculate stats/counts for today
        const statsQuery = appointmentRepo.createQueryBuilder("apt")
            .select("COUNT(*)", "todayCount")
            .addSelect("COUNT(CASE WHEN LOWER(apt.Status) IN ('confirmed', 'completed', 'scheduled') THEN 1 END)", "confirmedCount")
            .addSelect("COUNT(CASE WHEN LOWER(apt.Status) IN ('pending', 'paymentpending', 'requested') THEN 1 END)", "pendingCount")
            .where("apt.DoctorId = :doctorId", { doctorId });

        if (hospitalId) {
            statsQuery.andWhere("apt.HospitalId = :hospitalId", { hospitalId });
        }
        if (orgId) {
            statsQuery.andWhere("apt.OrgId = :orgId", { orgId });
        }
        statsQuery.andWhere("CAST(apt.AppointmentDate AS DATE) = :todayStr", { todayStr });

        const statsResult = await statsQuery.getRawOne();
        const todayCount = parseInt(statsResult?.todayCount || "0", 10);
        const confirmedCount = parseInt(statsResult?.confirmedCount || "0", 10);
        const pendingCount = parseInt(statsResult?.pendingCount || "0", 10);

        // 2. Fetch appointments list
        const query = appointmentRepo.createQueryBuilder("apt")
            .leftJoinAndSelect("apt.User", "user")
            .where("apt.DoctorId = :doctorId", { doctorId });

        if (hospitalId) {
            query.andWhere("apt.HospitalId = :hospitalId", { hospitalId });
        }
        if (orgId) {
            query.andWhere("apt.OrgId = :orgId", { orgId });
        }

        if (options?.dateFrom && options?.dateTo) {
            query.andWhere("CAST(apt.AppointmentDate AS DATE) >= :dateFrom", { dateFrom: options.dateFrom });
            query.andWhere("CAST(apt.AppointmentDate AS DATE) <= :dateTo", { dateTo: options.dateTo });
        } else if (options?.date) {
            query.andWhere("CAST(apt.AppointmentDate AS DATE) = :dateStr", { dateStr: options.date });
        } else {
            query.andWhere("CAST(apt.AppointmentDate AS DATE) = :todayStr", { todayStr });
        }

        if (options?.status && options.status !== "All Status") {
            query.andWhere("LOWER(apt.Status) = :status", { status: options.status.toLowerCase() });
        }

        if (options?.search && options.search.trim() !== "") {
            const searchPattern = `%${options.search.trim().toLowerCase()}%`;
            query.andWhere("(LOWER(user.FirstName) LIKE :searchPattern OR LOWER(user.LastName) LIKE :searchPattern OR LOWER(user.PhoneNumber) LIKE :searchPattern)", { searchPattern });
        }

        const appointments = await query
            .orderBy("apt.StartTime", "ASC")
            .getMany();

        const formatTime12h = (timeStr: string) => {
            if (!timeStr) return "";
            const parts = timeStr.split(":");
            if (parts.length < 2) return timeStr;
            let hour = parseInt(parts[0], 10);
            const min = parts[1];
            const ampm = hour >= 12 ? "PM" : "AM";
            hour = hour % 12;
            hour = hour ? hour : 12;
            const hourStr = hour < 10 ? `0${hour}` : `${hour}`;
            return `${hourStr}:${min} ${ampm}`;
        };

        const formattedList = appointments.map((apt, index) => {
            const patientName = `${apt.User?.FirstName || ""} ${apt.User?.LastName || ""}`.trim() || "Patient";
            const phone = apt.User?.PhoneNumber || "";
            const formattedTime = formatTime12h(apt.StartTime);
            const durationMins = apt.Duration || 30;

            let normalizedStatus = "scheduled";
            const rawStatus = (apt.Status || "").toLowerCase();
            if (rawStatus.includes("confirm")) normalizedStatus = "confirmed";
            else if (rawStatus.includes("progress")) normalizedStatus = "inProgress";
            else if (rawStatus.includes("complete")) normalizedStatus = "completed";
            else if (rawStatus.includes("pending")) normalizedStatus = "paymentPending";
            else if (rawStatus.includes("cancel")) normalizedStatus = "cancelled";

            let patientStatus = "Active";
            const typeLower = (apt.AppointmentType || "").toLowerCase();
            const reasonLower = (apt.Reason || "").toLowerCase();
            if (typeLower.includes("follow") || reasonLower.includes("follow") || apt.ParentAppointmentId) {
                patientStatus = "Follow-up";
            } else if (typeLower.includes("new") || reasonLower.includes("new")) {
                patientStatus = "New Patient";
            }

            return {
                id: String(apt.Id),
                tokenNumber: `Token #${index + 1}`,
                time: formattedTime || apt.StartTime,
                duration: `${durationMins} MIN`,
                patientName,
                phoneNumber: phone,
                type: apt.IsTeleConsultation ? "videoCall" : "inClinic",
                category: apt.AppointmentType || apt.Reason || "Consultation",
                status: normalizedStatus,
                patientStatus,
                appointmentDate: apt.AppointmentDate,
                meetingUrl: apt.MeetingUrl || null,
                patientUserId: apt.UserId || null,
                orgId: apt.OrgId || null,
                hospitalId: apt.HospitalId || null,
                reason: apt.Reason || ""
            };
        });

        return {
            todayCount,
            confirmedCount,
            pendingCount,
            aiOptimizationScore: 94,
            appointments: formattedList
        };
    }

    async bookAppointment(data: {
        doctorId: string;
        hospitalId: number;
        orgId: number;
        patientName?: string;
        patientPhone: string;
        gender?: string;
        dob?: string;
        appointmentDate: string;
        startTime: string;
        reason?: string;
        appointmentType?: string;
        isTeleConsultation?: boolean;
        parentAppointmentId?: number | null;
        treatmentPlanIds?: string[];
        customTreatmentPlans?: { name: string; amount: number; description?: string }[];
        discountAmount?: number;
    }): Promise<any> {
        const userRepo = AppDataSource.getRepository(User);
        const userRoleRepo = AppDataSource.getRepository(UserRole);
        const patientRegRepo = AppDataSource.getRepository(PatientRegistration);
        const appointmentRepo = AppDataSource.getRepository(Appointment);
        const slotRepo = AppDataSource.getRepository(HealthcareProviderScheduleSlot);

        const cleanPhone = (data.patientPhone || "").replace(/[^\d]/g, "");
        if (!cleanPhone || cleanPhone.length < 10) {
            throw new Error("Valid patient phone number is required");
        }

        const last10Digits = cleanPhone.slice(-10);

        // 1. Verify Slot Availability
        const provider = await healthcareProviderRepository.findByUserIdAndHospital(data.doctorId, data.hospitalId);
        const providerIdNum = provider ? provider.Id : (Number(data.doctorId) || 1);
        const normalizedStartTime = (data.startTime || "10:00:00").trim();
        const startPrefix = normalizedStartTime.slice(0, 5);

        const slot = await slotRepo.createQueryBuilder("slot")
            .where("slot.ProviderId = :providerId", { providerId: providerIdNum })
            .andWhere("slot.HospitalId = :hospitalId", { hospitalId: data.hospitalId })
            .andWhere("CAST(slot.SlotDate AS DATE) = CAST(:targetDate AS DATE)", { targetDate: data.appointmentDate })
            .andWhere("slot.StartTime LIKE :startTimePattern", { startTimePattern: `${startPrefix}%` })
            .andWhere("slot.IsDeleted = 0")
            .getOne();

        if (slot) {
            if (slot.IsBooked) {
                throw new Error("The selected slot is already booked. Please select an available slot.");
            }
            if (!slot.IsAvailable) {
                throw new Error("The selected slot is blocked/unavailable. Please choose an available slot.");
            }
        }

        let patientUser = await userRepo.createQueryBuilder("u")
            .where("u.IsDeleted = 0")
            .andWhere("(u.PhoneNumber = :phone OR u.PhoneNumber LIKE :last10)", {
                phone: cleanPhone,
                last10: `%${last10Digits}`
            })
            .getOne();

        if (!patientUser) {
            patientUser = new User();
            patientUser.Id = uuidv4();
            patientUser.IsPrimary = true;
            patientUser.Relation = "Self";

            const nameParts = (data.patientName || "Mobile Patient").trim().split(" ");
            patientUser.FirstName = nameParts[0];
            patientUser.LastName = nameParts.slice(1).join(" ") || "";
            patientUser.PhoneNumber = cleanPhone;
            if (data.gender) patientUser.Gender = data.gender;
            if (data.dob) (patientUser as any).Dob = new Date(data.dob);
            patientUser.Email = `${last10Digits}@yira.ai`;
            patientUser.Status = true;
            patientUser.IsDeleted = false;
            await userRepo.save(patientUser);
        } else if (data.patientName && (!patientUser.FirstName || patientUser.FirstName === "Mobile" || patientUser.FirstName === "Patient")) {
            const nameParts = data.patientName.trim().split(" ");
            patientUser.FirstName = nameParts[0];
            patientUser.LastName = nameParts.slice(1).join(" ") || "";
            await userRepo.save(patientUser);
        }

        // Ensure UserRole mapping exists for Patient
        const existingRole = await userRoleRepo.findOne({
            where: { UserId: patientUser.Id, OrganizationId: data.orgId, HospitalId: data.hospitalId, IsDeleted: false }
        });

        if (!existingRole) {
            const roleRepo = AppDataSource.getRepository(Role);
            const patientRole = await roleRepo.findOne({ where: { RoleName: "Patient" } });

            const userRole = new UserRole();
            userRole.UserId = patientUser.Id;
            userRole.RoleId = patientRole ? patientRole.Id : "4FC67429-28AE-4106-93EF-436228282ED0";
            userRole.OrganizationId = data.orgId;
            userRole.HospitalId = data.hospitalId;
            userRole.Status = true;
            userRole.IsDeleted = false;
            await userRoleRepo.save(userRole);
        }

        // Ensure PatientRegistration mapping exists
        const existingReg = await patientRegRepo.findOne({
            where: { UserId: patientUser.Id, OrganizationId: data.orgId, HospitalId: data.hospitalId }
        });

        if (!existingReg) {
            const patientReg = new PatientRegistration();
            patientReg.UserId = patientUser.Id;
            patientReg.OrganizationId = data.orgId;
            patientReg.HospitalId = data.hospitalId;
            patientReg.Status = true;
            patientReg.IsDeleted = false;
            await patientRegRepo.save(patientReg);
        }

        // Create & Save Appointment
        const appointment = new Appointment();
        appointment.UserId = patientUser.Id;
        appointment.DoctorId = data.doctorId;
        appointment.OrgId = data.orgId;
        appointment.HospitalId = data.hospitalId;
        appointment.AppointmentDate = new Date(data.appointmentDate);
        appointment.StartTime = normalizedStartTime;
        appointment.Duration = 30;
        appointment.Reason = data.reason || "General Checkup";
        appointment.AppointmentType = data.appointmentType || (data.isTeleConsultation ? "Video Consultation" : "In-Clinic");
        appointment.IsTeleConsultation = data.isTeleConsultation || false;
        appointment.Status = "Scheduled";
        appointment.CreatedBy = "MobileApp";
        if (data.parentAppointmentId) {
            appointment.ParentAppointmentId = Number(data.parentAppointmentId);
        }
        if (slot) {
            appointment.SlotId = slot.Id;
        }

        // Generate Zoom Link for Teleconsultation
        if (appointment.IsTeleConsultation) {
            try {
                const zoomMeeting = await zoomService.createMeeting(
                    `Consultation: ${data.reason || 'General'}`,
                    appointment.AppointmentDate
                );
                appointment.MeetingUrl = zoomMeeting.join_url;
            } catch (zoomErr) {
                console.error("Zoom meeting creation error during mobile booking:", zoomErr);
            }
        }

        const savedAppointment = await appointmentRepo.save(appointment);

        // 1. Link Treatment Plans
        if (data.treatmentPlanIds && data.treatmentPlanIds.length > 0) {
            try {
                const { AppointmentTreatmentPlan } = await import("../../../../models/Payments/appointment-treatment-plan.model.js");
                const atpRepo = AppDataSource.getRepository(AppointmentTreatmentPlan);
                for (const planId of data.treatmentPlanIds) {
                    const link = atpRepo.create({
                        AppointmentTreatmentPlanId: uuidv4(),
                        AppointmentId: savedAppointment.Id,
                        TreatmentPlanId: planId,
                        CreatedAt: new Date()
                    });
                    await atpRepo.save(link);
                }
            } catch (tpErr) {
                console.error("Error linking treatment plans in mobile appointment:", tpErr);
            }
        }

        // 1.5. Create & Link Custom Treatment Plans
        if (data.customTreatmentPlans && data.customTreatmentPlans.length > 0) {
            try {
                const { TreatmentPlan } = await import("../../../../models/Payments/treatment-plan.model.js");
                const { AppointmentTreatmentPlan } = await import("../../../../models/Payments/appointment-treatment-plan.model.js");
                const tpRepo = AppDataSource.getRepository(TreatmentPlan);
                const atpRepo = AppDataSource.getRepository(AppointmentTreatmentPlan);
                for (const customPlan of data.customTreatmentPlans) {
                    if (!customPlan.name) continue;
                    const newPlan = tpRepo.create({
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
                    await tpRepo.save(newPlan);

                    const link = atpRepo.create({
                        AppointmentTreatmentPlanId: uuidv4(),
                        AppointmentId: savedAppointment.Id,
                        TreatmentPlanId: newPlan.TreatmentPlanId,
                        CreatedAt: new Date()
                    });
                    await atpRepo.save(link);
                }
            } catch (customTpErr) {
                console.error("Error saving custom treatment plans in mobile appointment:", customTpErr);
            }
        }

        // Mark Slot as Booked in Database
        if (slot) {
            slot.IsBooked = true;
            await slotRepo.save(slot);
        }

        // Fetch Doctor details for notifications
        const doctorUser = await userRepo.findOne({ where: { Id: data.doctorId } });
        const doctorName = doctorUser ? `${doctorUser.FirstName || ""} ${doctorUser.LastName || ""}`.trim() : "Doctor";
        const patientName = `${patientUser.FirstName || ""} ${patientUser.LastName || ""}`.trim();
        const dateStr = new Date(savedAppointment.AppointmentDate).toLocaleDateString("en-IN", {
            day: "2-digit", month: "short", year: "numeric"
        });

        // 1. Trigger Push Notification to Doctor & Patient
        try {
            await pushNotificationService.notifyAppointmentBooked({
                appointmentId: savedAppointment.Id,
                doctorId: data.doctorId,
                patientId: patientUser.Id,
                doctorName,
                patientName,
                date: dateStr,
                time: savedAppointment.StartTime || "10:00 AM",
                consultationType: savedAppointment.AppointmentType
            });
        } catch (e) {
            console.error("Failed to send appointment push notification:", e);
        }

        // 2. Trigger WhatsApp Message to Patient
        try {
            const hospitalRepo = AppDataSource.getRepository(Hospital);
            const hospital = await hospitalRepo.findOne({ where: { Id: data.hospitalId } });
            const hospitalName = hospital?.Name || "our clinic";
            const countryCode = patientUser.CountryCode || "91";
            const cleanDigits = patientUser.PhoneNumber.replace(/\D/g, "");
            const normalizedPhone = cleanDigits.length === 10 ? `${countryCode.replace(/\D/g, "")}${cleanDigits}` : cleanDigits;

            const templateName = data.isTeleConsultation ? "video_call_template" : "appointment_conformation";
            const timeDisplay = (savedAppointment.StartTime || "10:00").slice(0, 5);

            const components: any[] = [
                {
                    type: "header",
                    parameters: [{ type: "text", text: hospitalName }]
                },
                {
                    type: "body",
                    parameters: [
                        { type: "text", text: patientName },
                        { type: "text", text: doctorName },
                        { type: "text", text: hospitalName },
                        { type: "text", text: dateStr },
                        { type: "text", text: timeDisplay }
                    ]
                }
            ];

            try {
                await whatsappService.sendTemplateMessage(normalizedPhone, templateName, "en", components);
                console.log(`[MobileAppointmentService] WhatsApp template '${templateName}' sent to ${normalizedPhone}`);
            } catch (templateErr) {
                console.warn(`[MobileAppointmentService] WhatsApp template message failed, sending fallback text:`, templateErr);
                const fallbackMessage = `Hello ${patientName},\n\nYour appointment with Dr. ${doctorName} at ${hospitalName} is confirmed for ${dateStr} at ${timeDisplay}.\n\nThank you for choosing ClinicX!`;
                await whatsappService.sendTextMessage(normalizedPhone, fallbackMessage);
                console.log(`[MobileAppointmentService] WhatsApp text message sent to ${normalizedPhone}`);
            }
        } catch (waErr) {
            console.error("[MobileAppointmentService] WhatsApp messaging error:", waErr);
        }

        return {
            appointmentId: savedAppointment.Id,
            patientUserId: patientUser.Id,
            patientName: `${patientUser.FirstName || ""} ${patientUser.LastName || ""}`.trim(),
            appointmentDate: savedAppointment.AppointmentDate,
            startTime: savedAppointment.StartTime,
            status: savedAppointment.Status
        };
    }

    async updateAppointmentStatus(appointmentId: string, status: string): Promise<any> {
        const appointmentRepo = AppDataSource.getRepository(Appointment);
        const appointment = await appointmentRepo.findOne({ 
            where: { Id: Number(appointmentId) },
            relations: ["User", "Doctor"]
        });
        if (!appointment) {
            throw new Error("Appointment not found");
        }
        appointment.Status = status;
        await appointmentRepo.save(appointment);

        // Trigger Push Notification for status update
        try {
            const patientName = appointment.User ? `${appointment.User.FirstName || ""} ${appointment.User.LastName || ""}`.trim() : "Patient";
            const doctorName = appointment.Doctor ? `${appointment.Doctor.FirstName || ""} ${appointment.Doctor.LastName || ""}`.trim() : "Doctor";
            const dateStr = new Date(appointment.AppointmentDate).toLocaleDateString("en-IN", {
                day: "2-digit", month: "short", year: "numeric"
            });

            await pushNotificationService.notifyAppointmentStatusChanged({
                appointmentId: appointment.Id,
                doctorId: appointment.DoctorId,
                patientId: appointment.UserId,
                doctorName,
                patientName,
                date: dateStr,
                status: appointment.Status
            });
        } catch (e) {
            console.error("Failed to send status update push notification:", e);
        }

        return { appointmentId, status: appointment.Status };
    }
}

export const mobileAppointmentService = new MobileAppointmentService();
