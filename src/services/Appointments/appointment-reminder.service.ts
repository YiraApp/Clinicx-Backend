import { appointmentRepository } from "../../repositories/Appointments/appointment.repository.js";
import { meetingRedirectionService } from "./meeting-redirection.service.js";
import { whatsappService } from "../Common/whatsapp.service.js";
import { AppDataSource } from "../../config/database.js";
import { Appointment } from "../../models/Appointments/appointment.model.js";

export interface ReminderResult {
    success: boolean;
    appointmentId: number;
    phone?: string;
    template?: string;
    variables?: {
        patientName: string;
        doctorName: string;
        timeRemaining: string;
        appointmentDate: string;
        appointmentTime: string;
        location: string;
        redirectionToken: string;
    };
    error?: string;
}

export class AppointmentReminderService {
    // In-memory tracker to prevent sending duplicate reminders (e.g., "1234_10m_2026-08-12")
    private sentReminders = new Set<string>();
    private cronInterval: NodeJS.Timeout | null = null;

    /**
     * Sends the WhatsApp reminder template ("remainder_template") to the patient.
     * 
     * Template structure:
     * Hello {{1}},
     * This is a reminder that your appointment with {{2}} is scheduled in {{3}}.
     * 
     * Appointment Details
     * • Date: {{4}}
     * • Time: {{5}}
     * • Location: {{6}}
     * 
     * Please join your appointment 5 minutes before the scheduled time.
     * 
     * Regards,
     * Yira.ai
     * 
     * Variables:
     * {{1}} - Patient Name
     * {{2}} - Doctor Name
     * {{3}} - Time Remaining (e.g., "10 minutes", "15 minutes", "1 hour")
     * {{4}} - Appointment Date
     * {{5}} - Appointment Time
     * {{6}} - Location (Hospital/Clinic name or "Online Video Consultation")
     * 
     * CTA Button:
     * Visit Website -> Dynamic URL with UrlId token
     */
    async sendAppointmentReminder(
        appointmentId: number | string, 
        timeRemaining: string = "10 minutes",
        templateName: string = "remainder_template"
    ): Promise<ReminderResult> {
        try {
            const numericId = typeof appointmentId === "string" ? parseInt(appointmentId, 10) : appointmentId;
            const appt = await appointmentRepository.findById(numericId);

            if (!appt) {
                return { success: false, appointmentId: numericId, error: "Appointment not found" };
            }

            if (!appt.User || !appt.User.PhoneNumber) {
                return { success: false, appointmentId: numericId, error: "Patient phone number not found" };
            }

            // 1. Resolve Redirection link / CTA button parameter
            const redirection = await meetingRedirectionService.getOrCreateRedirection({
                AppointmentId: appt.Id,
                PatientId: appt.UserId,
                DoctorId: appt.DoctorId,
                HospitalId: appt.HospitalId,
                OrganizationId: appt.OrgId,
                MeetingUrl: appt.MeetingUrl || "",
                AppointmentDate: appt.AppointmentDate,
                StartTime: appt.StartTime
            });

            // 2. Format Variables
            const patientName = `${appt.User?.FirstName || ""} ${appt.User?.LastName || ""}`.trim() || "Patient";
            const doctorName = appt.Doctor 
                ? `Dr. ${appt.Doctor.FirstName || ""} ${appt.Doctor.LastName || ""}`.trim()
                : "your doctor";
            
            const dateObj = new Date(appt.AppointmentDate);
            const dateStr = !isNaN(dateObj.getTime())
                ? dateObj.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
                : String(appt.AppointmentDate);

            // Format time (e.g. 11:30 AM or 11:30)
            let timeStr = appt.StartTime ? appt.StartTime.slice(0, 5) : "";
            if (appt.StartTime && appt.StartTime.includes(":")) {
                const [h, m] = appt.StartTime.split(":");
                const hourNum = parseInt(h, 10);
                const period = hourNum >= 12 ? "PM" : "AM";
                const displayHour = hourNum % 12 || 12;
                timeStr = `${displayHour}:${m} ${period}`;
            }

            // Location
            let locationStr = appt.Hospital?.Name || "our clinic";
            if (appt.IsTeleConsultation) {
                locationStr = "Online Video Consultation";
            }

            const countryCode = appt.User.CountryCode || "91";
            const normalizedPhone = `${countryCode.replace(/\D/g, "")}${appt.User.PhoneNumber.replace(/\D/g, "")}`;

            // 3. Build WhatsApp Template Components
            const components: any[] = [
                {
                    type: "body",
                    parameters: [
                        { type: "text", text: patientName },         // {{1}}
                        { type: "text", text: doctorName },          // {{2}}
                        { type: "text", text: timeRemaining },        // {{3}}
                        { type: "text", text: dateStr },              // {{4}}
                        { type: "text", text: timeStr },              // {{5}}
                        { type: "text", text: locationStr }           // {{6}}
                    ]
                }
            ];

            // Add CTA Button parameter (UrlId)
            if (redirection && redirection.UrlId) {
                components.push({
                    type: "button",
                    sub_type: "url",
                    index: "0",
                    parameters: [
                        { type: "text", text: redirection.UrlId }
                    ]
                });
            }

            console.log(`[AppointmentReminder] Sending ${templateName} to ${normalizedPhone} for Appt #${appt.Id}...`);
            await whatsappService.sendTemplateMessage(normalizedPhone, templateName, "en", components);
            console.log(`[AppointmentReminder] Successfully sent ${templateName} for Appt #${appt.Id} (Scheduled in ${timeRemaining})`);

            return {
                success: true,
                appointmentId: numericId,
                phone: normalizedPhone,
                template: templateName,
                variables: {
                    patientName,
                    doctorName,
                    timeRemaining,
                    appointmentDate: dateStr,
                    appointmentTime: timeStr,
                    location: locationStr,
                    redirectionToken: redirection?.UrlId || ""
                }
            };
        } catch (error: any) {
            console.error(`[AppointmentReminder] Error sending reminder for Appt #${appointmentId}:`, error.message || error);
            return {
                success: false,
                appointmentId: typeof appointmentId === "string" ? parseInt(appointmentId, 10) : appointmentId,
                error: error.message || "Failed to send WhatsApp reminder"
            };
        }
    }

    /**
     * Checks today's appointments and sends automated 10-minute reminders.
     */
    async checkAndSendUpcomingReminders(): Promise<number> {
        try {
            const now = new Date();
            // Today's date string YYYY-MM-DD
            const todayStr = now.toISOString().split("T")[0];

            const appointments = await AppDataSource.getRepository(Appointment)
                .createQueryBuilder("a")
                .leftJoinAndSelect("a.User", "user")
                .leftJoinAndSelect("a.Doctor", "doctor")
                .leftJoinAndSelect("a.Hospital", "hospital")
                .where("CAST(a.AppointmentDate AS DATE) = :today", { today: todayStr })
                .andWhere("a.Status NOT IN (:...excludeStatuses)", { 
                    excludeStatuses: ["Cancelled", "Completed", "NoShow", "Rejected"] 
                })
                .getMany();

            let sentCount = 0;

            for (const appt of appointments) {
                if (!appt.StartTime) continue;

                // Calculate appointment date/time
                const [startH, startM] = appt.StartTime.split(":").map(n => parseInt(n, 10));
                const apptDateTime = new Date(appt.AppointmentDate);
                apptDateTime.setHours(startH, startM || 0, 0, 0);

                const diffMs = apptDateTime.getTime() - now.getTime();
                const diffMinutes = Math.round(diffMs / (1000 * 60));

                // Check for 10-minute window: between 8 and 14 minutes before appointment
                const reminderKey10m = `${appt.Id}_10m_${todayStr}`;

                if (diffMinutes >= 8 && diffMinutes <= 14 && !this.sentReminders.has(reminderKey10m)) {
                    this.sentReminders.add(reminderKey10m);
                    console.log(`[AppointmentReminder] Auto-triggering 10m reminder for Appt #${appt.Id} (Starts in ~${diffMinutes}m)`);
                    
                    // 1. Send WhatsApp reminder
                    await this.sendAppointmentReminder(appt.Id, "10 minutes");

                    // 2. Dispatch Live Push Notification to Doctor & Patient
                    try {
                        const { pushNotificationService } = await import("../Notifications/push-notification.service.js");
                        const patientName = `${appt.User?.FirstName || ""} ${appt.User?.LastName || ""}`.trim() || "Patient";
                        const doctorName = appt.Doctor 
                            ? `${appt.Doctor.FirstName || ""} ${appt.Doctor.LastName || ""}`.trim()
                            : "Doctor";
                        await pushNotificationService.notifyAppointment10MinReminder({
                            appointmentId: appt.Id,
                            doctorId: appt.DoctorId,
                            patientId: appt.UserId,
                            doctorName,
                            patientName,
                            date: todayStr,
                            time: appt.StartTime,
                            consultationType: appt.IsTeleConsultation ? "Video Consultation" : "In-Clinic"
                        });
                    } catch (pushErr: any) {
                        console.error("[AppointmentReminder] Mobile push reminder error:", pushErr?.message || pushErr);
                    }

                    sentCount++;
                }
            }

            return sentCount;
        } catch (err: any) {
            console.error("[AppointmentReminder] Error in checkAndSendUpcomingReminders:", err.message || err);
            return 0;
        }
    }

    /**
     * Starts the automated background scheduler (runs every 60 seconds)
     */
    startScheduler(intervalSeconds: number = 60) {
        if (this.cronInterval) {
            clearInterval(this.cronInterval);
        }

        console.log(`[AppointmentReminder] Background reminder scheduler started (checking every ${intervalSeconds}s for 10-min reminders)`);
        this.cronInterval = setInterval(() => {
            this.checkAndSendUpcomingReminders();
        }, intervalSeconds * 1000);
    }

    /**
     * Stops the automated background scheduler
     */
    stopScheduler() {
        if (this.cronInterval) {
            clearInterval(this.cronInterval);
            this.cronInterval = null;
            console.log("[AppointmentReminder] Background reminder scheduler stopped.");
        }
    }
}

export const appointmentReminderService = new AppointmentReminderService();
