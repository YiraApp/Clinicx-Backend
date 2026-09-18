import { medicalDocumentRepository } from "../../repositories/Appointments/medical-document.repository.js";
import { appointmentShareLinkRepository } from "../../repositories/Appointments/appointment-share-link.repository.js";
import { appointmentRepository } from "../../repositories/Appointments/appointment.repository.js";
import { MedicalDocument } from "../../models/Appointments/medical-document.model.js";
import { blobService } from "../Common/blob.service.js";
import { v4 as uuidv4 } from "uuid";

const DEFAULT_UUID = "00000000-0000-0000-0000-000000000000";

function ensureUUID(str?: any): string {
    if (!str) return DEFAULT_UUID;
    const s = String(str).trim();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(s)) return s;
    return DEFAULT_UUID;
}

function toNullableUUID(str?: any): string | null {
    if (!str) return null;
    const s = String(str).trim();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(s)) return s;
    return null;
}

export class MedicalDocumentService {
    private pendingBookingTimers: Map<string, NodeJS.Timeout> = new Map();
    private bookingCronInterval: NodeJS.Timeout | null = null;

    /**
     * Send Appointment Booking WhatsApp template (yira_appointment_book) to patient.
     * Can be invoked manually from UI or automatically by the document upload scheduler.
     */
    async sendAppointmentBookingWhatsApp(patientId: string, hospitalId?: number, senderId?: string): Promise<any> {
        const { userRepository } = await import("../../repositories/Account/user.repository.js");
        const { hospitalRepository } = await import("../../repositories/Organizations/hospital.repository.js");
        const { defaultOrganizationRepository } = await import("../../repositories/Organizations/default-organization.repository.js");
        const { whatsappService } = await import("../Common/whatsapp.service.js");
        const { AppDataSource } = await import("../../config/database.js");
        const { AppNotification } = await import("../../models/Common/app-notification.model.js");

        const patient = await userRepository.findById(patientId);
        if (!patient) throw new Error("Patient not found.");

        const phone = patient.PhoneNumber;
        if (!phone) throw new Error("Patient does not have a registered mobile number.");

        let normalizedPhone = phone.replace(/\D/g, "");
        if (normalizedPhone.length === 10) {
            normalizedPhone = "91" + normalizedPhone;
        }

        const patientName = `${patient.FirstName || ""} ${patient.LastName || ""}`.trim() || "Valued Patient";

        // Resolve hospital name
        let targetHospId = hospitalId ? Number(hospitalId) : undefined;
        let hospitalName = "Yira Hospitals";

        if (targetHospId) {
            const hosp = await hospitalRepository.findById(targetHospId);
            if (hosp && hosp.Name) {
                hospitalName = hosp.Name;
            }
        } else {
            const activeDefault = await defaultOrganizationRepository.getActiveDefault();
            if (activeDefault) {
                targetHospId = activeDefault.HospitalId || 19;
                hospitalName = activeDefault.HospitalName || "Yira Hospitals";
            }
        }

        // WhatsApp template: yira_appointment_book
        // Body {{1}}: Patient Name, Body {{2}}: Hospital Name
        // Meta template button is a static URL, so components only supply body parameters
        const components = [
            {
                type: "body",
                parameters: [
                    { type: "text", text: patientName },
                    { type: "text", text: hospitalName }
                ]
            }
        ];

        console.log(`[MedicalDocumentService] Sending WhatsApp 'yira_appointment_book' to ${normalizedPhone} (Hospital: ${hospitalName})`);
        let whatsappResult: any = null;
        try {
            whatsappResult = await whatsappService.sendTemplateMessage(normalizedPhone, "yira_appointment_book", "en", components);
        } catch (waErr: any) {
            console.error(`[MedicalDocumentService] Failed to send 'yira_appointment_book' to ${normalizedPhone}:`, waErr.message);
            throw waErr;
        }

        // Record in AppNotification
        const notifRepo = AppDataSource.getRepository(AppNotification);
        const notif = new AppNotification();
        notif.UserId = patientId;
        notif.SenderId = toNullableUUID(senderId);
        notif.Title = "Appointment Booking Link Sent";
        notif.Body = `Appointment booking portal link sent to ${normalizedPhone} ('yira_appointment_book' template) for ${hospitalName}`;
        notif.Type = "WHATSAPP_APPOINTMENT_BOOK";
        notif.ReferenceId = patientId;
        notif.Route = "/book-appointment/" + (targetHospId || 19);
        notif.IsRead = true;
        await notifRepo.save(notif);

        return {
            success: true,
            whatsappResult,
            notification: notif
        };
    }

    /**
     * Trigger automatic appointment booking WhatsApp link after document upload
     * if enabled in HospitalSettings for this facility.
     */
    async triggerAutoBookingAfterDocument(patientId: string, hospitalId: number, senderId?: string): Promise<void> {
        try {
            const { hospitalSettingsService } = await import("../Organizations/hospital-settings.service.js");
            const { defaultOrganizationRepository } = await import("../../repositories/Organizations/default-organization.repository.js");
            const { AppDataSource } = await import("../../config/database.js");
            const { AppNotification } = await import("../../models/Common/app-notification.model.js");
            const { MoreThan } = await import("typeorm");

            let targetHospId = Number(hospitalId) || 0;
            let settings = targetHospId > 0 ? await hospitalSettingsService.getSettings(targetHospId) : null;

            // Fallback to active default organization if hospitalId is <= 1 or settings not enabled on hospital 1
            if (!settings?.SendBookingAfterDocument) {
                const activeDefault = await defaultOrganizationRepository.getActiveDefault();
                if (activeDefault?.HospitalId && activeDefault.HospitalId !== targetHospId) {
                    const defaultSettings = await hospitalSettingsService.getSettings(activeDefault.HospitalId);
                    if (defaultSettings?.SendBookingAfterDocument) {
                        console.log(`[MedicalDocumentService] Using default Hospital #${activeDefault.HospitalId} settings for auto-booking`);
                        targetHospId = activeDefault.HospitalId;
                        settings = defaultSettings;
                    }
                }
            }

            if (!settings || !settings.SendBookingAfterDocument) {
                console.log(`[MedicalDocumentService] Auto-booking link disabled for Hospital #${targetHospId || hospitalId}. Skipping.`);
                return;
            }

            const delayMinutes = Math.max(0, Number(settings.BookingAfterDocumentMinutes) || 0);
            console.log(`[MedicalDocumentService] SendBookingAfterDocument is ACTIVE for Hospital #${targetHospId} with ${delayMinutes}m delay.`);

            const notifRepo = AppDataSource.getRepository(AppNotification);

            if (delayMinutes <= 0) {
                // Immediate dispatch with debounce protection (check if already sent in last 5 minutes to avoid batch upload spam)
                const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
                const recentBooking = await notifRepo.findOne({
                    where: {
                        UserId: patientId,
                        Type: "WHATSAPP_APPOINTMENT_BOOK",
                        CreatedAt: MoreThan(fiveMinutesAgo)
                    }
                });
                if (recentBooking) {
                    console.log(`[MedicalDocumentService] Appointment booking link already sent to Patient ${patientId} recently. Skipping duplicate.`);
                    return;
                }

                console.log(`[MedicalDocumentService] Immediate dispatch of appointment booking link for Patient ${patientId}`);
                await this.sendAppointmentBookingWhatsApp(patientId, targetHospId, senderId || "AUTO_DOCUMENT_UPLOAD");
                return;
            }

            // Scheduled dispatch with debouncing
            const delayMs = delayMinutes * 60 * 1000;
            const executeAt = Date.now() + delayMs;

            // Clear any previously pending timer for this patient so we don't send duplicate spam
            if (this.pendingBookingTimers.has(patientId)) {
                clearTimeout(this.pendingBookingTimers.get(patientId)!);
                this.pendingBookingTimers.delete(patientId);
            }

            // Record pending notification in DB for crash recovery
            let pendingNotif = await notifRepo.findOne({
                where: { UserId: patientId, Type: "WHATSAPP_APPOINTMENT_BOOK_PENDING", IsRead: false }
            });

            if (!pendingNotif) {
                pendingNotif = new AppNotification();
                pendingNotif.UserId = patientId;
                pendingNotif.SenderId = toNullableUUID(senderId);
                pendingNotif.Title = "Pending Auto-Booking Link";
                pendingNotif.Type = "WHATSAPP_APPOINTMENT_BOOK_PENDING";
                pendingNotif.ReferenceId = patientId;
                pendingNotif.IsRead = false;
            }

            pendingNotif.Body = JSON.stringify({ hospitalId: targetHospId, executeAt, delayMinutes, senderId });
            pendingNotif.Route = "/book-appointment/" + targetHospId;
            await notifRepo.save(pendingNotif);

            const pendingId = pendingNotif.Id;

            // Schedule in-memory execution
            const timer = setTimeout(async () => {
                this.pendingBookingTimers.delete(patientId);
                try {
                    const { AppDataSource } = await import("../../config/database.js");
                    if (!AppDataSource.isInitialized) {
                        console.warn("[MedicalDocumentService] AppDataSource not initialized during timer expiry. Scheduler cron will process.");
                        return;
                    }
                    const notifRepository = AppDataSource.getRepository(AppNotification);
                    // Check if already claimed/processed by scheduler cron
                    const freshNotif = await notifRepository.findOne({ where: { Id: pendingId } });
                    if (!freshNotif || freshNotif.IsRead) {
                        console.log(`[MedicalDocumentService] Pending auto-booking ${pendingId} already processed. Skipping.`);
                        return;
                    }
                    freshNotif.IsRead = true;
                    await notifRepository.save(freshNotif);

                    console.log(`[MedicalDocumentService] Timer expired: Sending scheduled auto-booking link to Patient ${patientId} (after ${delayMinutes}m)`);
                    await this.sendAppointmentBookingWhatsApp(patientId, targetHospId, "AUTO_DOCUMENT_SCHEDULER");
                } catch (sendErr: any) {
                    console.error(`[MedicalDocumentService] Error executing scheduled booking link for Patient ${patientId}:`, sendErr.message);
                }
            }, delayMs);

            this.pendingBookingTimers.set(patientId, timer);
            console.log(`[MedicalDocumentService] Successfully scheduled appointment booking link for Patient ${patientId} in ${delayMinutes} minute(s).`);

        } catch (err: any) {
            console.error("[MedicalDocumentService] Error in triggerAutoBookingAfterDocument:", err.message);
        }
    }

    /**
     * Process due pending auto-booking notifications from DB (crash recovery & polling fallback)
     */
    async processDueBookingNotifications(): Promise<number> {
        try {
            const { AppDataSource } = await import("../../config/database.js");
            if (!AppDataSource.isInitialized) {
                return 0;
            }
            const { AppNotification } = await import("../../models/Common/app-notification.model.js");
            const notifRepo = AppDataSource.getRepository(AppNotification);

            const pendingList = await notifRepo.find({
                where: { Type: "WHATSAPP_APPOINTMENT_BOOK_PENDING", IsRead: false },
                take: 50
            });

            const now = Date.now();
            let processed = 0;

            for (const item of pendingList) {
                try {
                    let data: any = {};
                    try {
                        data = JSON.parse(item.Body);
                    } catch (e) {
                        data = {};
                    }

                    const executeAt = Number(data.executeAt) || 0;
                    if (executeAt > 0 && now >= executeAt) {
                        // Atomically claim notification so in-memory timer or concurrent crons do not double-send
                        item.IsRead = true;
                        await notifRepo.save(item);

                        // Clear any in-memory timer
                        if (this.pendingBookingTimers.has(item.UserId)) {
                            clearTimeout(this.pendingBookingTimers.get(item.UserId)!);
                            this.pendingBookingTimers.delete(item.UserId);
                        }

                        const hospitalId = Number(data.hospitalId) || 19;
                        console.log(`[MedicalDocumentService] Scheduler picked up due auto-booking notification for Patient ${item.UserId}`);
                        await this.sendAppointmentBookingWhatsApp(item.UserId, hospitalId, "AUTO_DOCUMENT_SCHEDULER");
                        processed++;
                    }
                } catch (itemErr: any) {
                    console.error(`[MedicalDocumentService] Error processing pending item ${item.Id}:`, itemErr.message);
                }
            }

            return processed;
        } catch (err: any) {
            console.error("[MedicalDocumentService] Error in processDueBookingNotifications:", err.message);
            return 0;
        }
    }

    /**
     * Start background polling scheduler for due auto-booking notifications
     */
    startBookingScheduler(intervalSeconds: number = 30): void {
        if (this.bookingCronInterval) {
            clearInterval(this.bookingCronInterval);
        }

        console.log(`[MedicalDocumentService] Document auto-booking scheduler started (checking every ${intervalSeconds}s)`);
        this.bookingCronInterval = setInterval(() => {
            this.processDueBookingNotifications();
        }, intervalSeconds * 1000);
    }

    stopBookingScheduler(): void {
        if (this.bookingCronInterval) {
            clearInterval(this.bookingCronInterval);
            this.bookingCronInterval = null;
            console.log("[MedicalDocumentService] Document auto-booking scheduler stopped.");
        }
    }

    async sendAppointmentBookingTemplate(patientId: string, hospitalId?: number, senderId?: string): Promise<any> {
        return this.sendAppointmentBookingWhatsApp(patientId, hospitalId, senderId);
    }

    async scheduleAppointmentBookingFollowup(patientId: string, hospitalId?: number, senderId?: string, overrideDelayMinutes?: number): Promise<void> {
        return this.triggerAutoBookingAfterDocument(patientId, hospitalId || 0, senderId);
    }

    async sendDentalConsultationWhatsApp(patientId: string, senderId?: string): Promise<any> {
        const { userRepository } = await import("../../repositories/Account/user.repository.js");
        const { whatsappService } = await import("../Common/whatsapp.service.js");
        const { AppDataSource } = await import("../../config/database.js");
        const { AppNotification } = await import("../../models/Common/app-notification.model.js");

        const patient = await userRepository.findById(patientId);
        if (!patient) throw new Error("Patient not found.");

        const phone = patient.PhoneNumber;
        if (!phone) throw new Error("Patient does not have a registered mobile number.");

        let normalizedPhone = phone.replace(/\D/g, "");
        if (normalizedPhone.length === 10) {
            normalizedPhone = "91" + normalizedPhone;
        }

        const patientName = `${patient.FirstName || ""} ${patient.LastName || ""}`.trim() || "Valued Patient";

        // Template 'dental_consultation':
        // Dear {{1}},
        // Your dental consultation has been scheduled.
        // Please visit Ocimum Dentistry and share your Member Reference at the clinic.
        // Thank you,
        // Yira Clinx
        const components = [
            {
                type: "body",
                parameters: [
                    { type: "text", text: patientName }
                ]
            }
        ];

        console.log(`[MedicalDocumentService] Sending WhatsApp 'dental_consultation' to ${normalizedPhone}`);
        const result = await whatsappService.sendTemplateMessage(normalizedPhone, "dental_consultation", "en", components);

        // Record in AppNotification
        const notifRepo = AppDataSource.getRepository(AppNotification);
        const notif = new AppNotification();
        notif.UserId = patientId;
        notif.SenderId = senderId || null;
        notif.Title = "Dental Consultation Scheduled";
        notif.Body = `Dental consultation notification sent to ${normalizedPhone} ('dental_consultation' template)`;
        notif.Type = "WHATSAPP_DENTAL_CONSULTATION";
        notif.ReferenceId = patientId;
        notif.Route = "/patient/overview";
        notif.IsRead = false;
        notif.CreatedAt = new Date();
        await notifRepo.save(notif);

        return {
            success: true,
            whatsappResult: result,
            notification: notif
        };
    }


    async sendEyeConsultationWhatsApp(patientId: string, senderId?: string): Promise<any> {
        const { userRepository } = await import("../../repositories/Account/user.repository.js");
        const { whatsappService } = await import("../Common/whatsapp.service.js");
        const { AppDataSource } = await import("../../config/database.js");
        const { AppNotification } = await import("../../models/Common/app-notification.model.js");

        const patient = await userRepository.findById(patientId);
        if (!patient) throw new Error("Patient not found.");

        const phone = patient.PhoneNumber;
        if (!phone) throw new Error("Patient does not have a registered mobile number.");

        let normalizedPhone = phone.replace(/\D/g, "");
        if (normalizedPhone.length === 10) {
            normalizedPhone = "91" + normalizedPhone;
        }

        const patientName = `${patient.FirstName || ""} ${patient.LastName || ""}`.trim() || "Valued Patient";

        // Template 'eye_consultation':
        // Dear {{1}},
        // Your eye consultation has been scheduled.
        // Please visit the nearest Vasan Eye Care and share your Member Reference at the clinic.
        // Thank you,
        // Yira Clinx
        const components = [
            {
                type: "body",
                parameters: [
                    { type: "text", text: patientName }
                ]
            }
        ];

        console.log(`[MedicalDocumentService] Sending WhatsApp 'eye_consultation' to ${normalizedPhone}`);
        const result = await whatsappService.sendTemplateMessage(normalizedPhone, "eye_consultation", "en", components);

        // Record in AppNotification
        const notifRepo = AppDataSource.getRepository(AppNotification);
        const notif = new AppNotification();
        notif.UserId = patientId;
        notif.SenderId = senderId || null;
        notif.Title = "Eye Consultation Scheduled";
        notif.Body = `Eye consultation notification sent to ${normalizedPhone} ('eye_consultation' template)`;
        notif.Type = "WHATSAPP_EYE_CONSULTATION";
        notif.ReferenceId = patientId;
        notif.Route = "/patient/overview";
        notif.IsRead = false;
        notif.CreatedAt = new Date();
        await notifRepo.save(notif);

        return {
            success: true,
            whatsappResult: result,
            notification: notif
        };
    }


    async sendAppointmentBookingTemplate(patientId: string, hospitalId?: number, senderId?: string): Promise<any> {
        const { userRepository } = await import("../../repositories/Account/user.repository.js");
        const { hospitalRepository } = await import("../../repositories/Organizations/hospital.repository.js");
        const { defaultOrganizationRepository } = await import("../../repositories/Organizations/default-organization.repository.js");
        const { whatsappService } = await import("../Common/whatsapp.service.js");
        const { AppDataSource } = await import("../../config/database.js");
        const { AppNotification } = await import("../../models/Common/app-notification.model.js");

        const patient = await userRepository.findById(patientId);
        if (!patient) throw new Error("Patient not found.");

        const phone = patient.PhoneNumber;
        if (!phone) throw new Error("Patient does not have a registered mobile number.");

        let normalizedPhone = phone.replace(/\D/g, "");
        if (normalizedPhone.length === 10) {
            normalizedPhone = "91" + normalizedPhone;
        }

        const patientName = `${patient.FirstName || ""} ${patient.LastName || ""}`.trim() || "Valued Patient";

        // Resolve hospital name
        let hospitalName = "Yira Hospitals";
        let targetHospId = hospitalId;
        if (targetHospId) {
            const hosp = await hospitalRepository.findById(targetHospId);
            if (hosp?.Name) hospitalName = hosp.Name;
        } else {
            const activeDefault = await defaultOrganizationRepository.getActiveDefault();
            if (activeDefault?.HospitalName) hospitalName = activeDefault.HospitalName;
            if (activeDefault?.HospitalId) targetHospId = activeDefault.HospitalId;
        }

        // Template 'yira_appointment_book' expects 2 body parameters:
        // {{1}} - Patient Name
        // {{2}} - Hospital Name
        const components = [
            {
                type: "body",
                parameters: [
                    { type: "text", text: patientName },
                    { type: "text", text: hospitalName }
                ]
            }
        ];

        console.log(`[MedicalDocumentService] Sending WhatsApp 'yira_appointment_book' to ${normalizedPhone} for ${patientName} (${hospitalName})`);
        const result = await whatsappService.sendTemplateMessage(normalizedPhone, "yira_appointment_book", "en", components);

        // Record in AppNotification
        const notifRepo = AppDataSource.getRepository(AppNotification);
        const notif = new AppNotification();
        notif.UserId = patientId;
        notif.SenderId = senderId || null;
        notif.Title = "Appointment Booking Link Sent";
        notif.Body = `Appointment booking template ('yira_appointment_book') sent to ${normalizedPhone} for ${hospitalName}`;
        notif.Type = "WHATSAPP_APPOINTMENT_BOOK";
        notif.ReferenceId = patientId;
        notif.Route = targetHospId ? `/book-appointment?hospitalId=${targetHospId}` : "/book-appointment";
        notif.IsRead = false;
        notif.CreatedAt = new Date();
        await notifRepo.save(notif);

        const apptBookCount = await notifRepo.count({
            where: { UserId: patientId, Type: "WHATSAPP_APPOINTMENT_BOOK" }
        });

        return {
            success: true,
            apptBookCount,
            whatsappResult: result,
            notification: notif
        };
    }


    async scheduleHomeSampleCollection(patientId: string, date: string, time: string, senderId?: string): Promise<any> {
        const { userRepository } = await import("../../repositories/Account/user.repository.js");
        const { whatsappService } = await import("../Common/whatsapp.service.js");
        const { AppDataSource } = await import("../../config/database.js");
        const { AppNotification } = await import("../../models/Common/app-notification.model.js");

        const patient = await userRepository.findById(patientId);
        if (!patient) throw new Error("Patient not found.");

        const phone = patient.PhoneNumber;
        if (!phone) throw new Error("Patient does not have a registered mobile number.");

        let normalizedPhone = phone.replace(/\D/g, "");
        if (normalizedPhone.length === 10) {
            normalizedPhone = "91" + normalizedPhone;
        }

        const patientName = `${patient.FirstName || ""} ${patient.LastName || ""}`.trim() || "Valued Patient";

        // Template 'hsp':
        // Dear {{1}},
        // Your Home Sample Collection has been successfully scheduled.
        // Date: {{2}}
        // Time: {{3}}
        const components = [
            {
                type: "body",
                parameters: [
                    { type: "text", text: patientName },
                    { type: "text", text: String(date) },
                    { type: "text", text: String(time) }
                ]
            }
        ];

        console.log(`[MedicalDocumentService] Sending WhatsApp 'hsp' to ${normalizedPhone} for Home Sample Collection`);
        const result = await whatsappService.sendTemplateMessage(normalizedPhone, "hsp", "en", components);

        // Record in AppNotification
        const notifRepo = AppDataSource.getRepository(AppNotification);
        const notif = new AppNotification();
        notif.UserId = patientId;
        notif.SenderId = senderId || null;
        notif.Title = "Home Sample Collection Scheduled";
        notif.Body = `Home Sample Collection scheduled for Date: ${date}, Time: ${time} ('hsp' template)`;
        notif.Type = "WHATSAPP_HOME_SAMPLE";
        notif.ReferenceId = patientId;
        notif.Route = "/patient/overview";
        notif.IsRead = false;
        notif.CreatedAt = new Date();
        await notifRepo.save(notif);

        return {
            success: true,
            whatsappResult: result,
            notification: notif
        };
    }


    async shareSingleDocument(documentId: number, patientId: string, senderId?: string): Promise<any> {
        const { medicalDocumentRepository } = await import("../../repositories/Appointments/medical-document.repository.js");
        const { appointmentShareLinkRepository } = await import("../../repositories/Appointments/appointment-share-link.repository.js");
        const { postVisitDocumentRepository } = await import("../../repositories/Appointments/post-visit-document.repository.js");
        const { userRepository } = await import("../../repositories/Account/user.repository.js");
        const { hospitalRepository } = await import("../../repositories/Organizations/hospital.repository.js");
        const { defaultOrganizationRepository } = await import("../../repositories/Organizations/default-organization.repository.js");
        const { whatsappService } = await import("../Common/whatsapp.service.js");
        const { AppDataSource } = await import("../../config/database.js");
        const { AppNotification } = await import("../../models/Common/app-notification.model.js");
        const { v4: uuidv4 } = await import("uuid");

        const doc = await medicalDocumentRepository.findById(documentId);
        if (!doc) throw new Error("Document not found.");

        const patient = await userRepository.findById(patientId);
        if (!patient) throw new Error("Patient not found.");

        const phone = patient.PhoneNumber;
        if (!phone) throw new Error("Patient does not have a registered mobile number.");

        let normalizedPhone = phone.replace(/\D/g, "");
        if (normalizedPhone.length === 10) {
            normalizedPhone = "91" + normalizedPhone;
        }

        const patientName = (patient.FirstName || "") + " " + (patient.LastName || "").trim() || "Valued Patient";

        // Resolve hospital name
        let hospitalName = "Yira Hospitals";
        if (doc.HospitalId) {
            const hosp = await hospitalRepository.findById(doc.HospitalId);
            if (hosp && hosp.Name) hospitalName = hosp.Name;
        } else {
            const activeDefault = await defaultOrganizationRepository.getActiveDefault();
            if (activeDefault && activeDefault.HospitalName) hospitalName = activeDefault.HospitalName;
        }

        // 1. Generate share token & link (https://clinix.yira.ai/view-summary/<token>)
        const shareToken = uuidv4();
        const baseUrl = process.env.FRONTEND_URL || process.env.CLIENT_URL || "https://clinix.yira.ai";
        const cleanBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
        const shareLinkUrl = cleanBaseUrl + "/view-summary/" + shareToken;

        const appointmentId = doc.AppointmentId || 0;

        const createdShareLink = await appointmentShareLinkRepository.create({
            AppointmentId: appointmentId,
            PatientId: patientId,
            OrganizationId: doc.OrganizationId || 1,
            HospitalId: doc.HospitalId || 19,
            ShareToken: shareToken,
            ShareLink: shareLinkUrl,
            ExpiryAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            IsActive: true,
            CreatedBy: senderId || "SYSTEM"
        });

        // 2. Register PostVisitDocument so summary portal displays this document
        await postVisitDocumentRepository.create({
            AppointmentId: appointmentId,
            PatientId: patientId,
            DoctorId: doc.DoctorId || undefined,
            OrganizationId: doc.OrganizationId || 1,
            HospitalId: doc.HospitalId || 19,
            DocumentType: doc.DocumentCategory || "Medical Document",
            FileName: doc.Description || doc.FileName || "Medical Document",
            BlobUrl: doc.BlobUrl,
            FileSize: doc.FileSize || undefined,
            MimeType: doc.MimeType || undefined,
            GeneratedAt: new Date(),
            SentOnWhatsApp: true,
            WhatsAppSentAt: new Date(),
            WhatsAppSentTo: normalizedPhone,
            WhatsAppSentCount: 1,
            ShareLinkId: createdShareLink.Id,
            Status: "ACTIVE"
        });

        // 3. Format WhatsApp template: medical_patient_documents
        // Header: Hospital Name
        // Body {{1}}: Patient Name, Body {{2}}: Hospital Name
        // Button (index 0): shareToken
        const components = [
            {
                type: "header",
                parameters: [
                    { type: "text", text: hospitalName }
                ]
            },
            {
                type: "body",
                parameters: [
                    { type: "text", text: patientName },
                    { type: "text", text: hospitalName }
                ]
            },
            {
                type: "button",
                sub_type: "url",
                index: 0,
                parameters: [
                    { type: "text", text: shareToken }
                ]
            }
        ];

        console.log("[MedicalDocumentService] Sending WhatsApp 'medical_patient_documents' to " + normalizedPhone + " for document " + (doc.FileName || "doc"));
        const result = await whatsappService.sendTemplateMessage(normalizedPhone, "medical_patient_documents", "en", components);

        // Increment WhatsAppSentCount directly in database on MedicalDocuments
        try {
            await medicalDocumentRepository.save({
                ...doc,
                WhatsAppSentCount: (Number(doc.WhatsAppSentCount) || 0) + 1,
                UpdatedAt: new Date()
            });
        } catch (dbErr: any) {
            console.warn("[MedicalDocumentService] DB increment warning:", dbErr.message);
        }

        // 4. Record AppNotification for history logs (WHATSAPP_SINGLE_DOCUMENT)
        const notifRepo = AppDataSource.getRepository(AppNotification);
        const notif = new AppNotification();
        notif.UserId = patientId;
        notif.SenderId = senderId || null;
        notif.Title = "Document Shared: " + (doc.Description || doc.FileName || "Medical Document");
        notif.Body = "Shared document '" + (doc.Description || doc.FileName) + "' via WhatsApp ('medical_patient_documents' template)";
        notif.Type = "WHATSAPP_SINGLE_DOCUMENT";
        notif.ReferenceId = String(documentId);
        notif.Route = "/view-summary/" + shareToken;
        notif.IsRead = false;
        notif.CreatedAt = new Date();
        await notifRepo.save(notif);

        const docCount = await notifRepo.count({
            where: { UserId: patientId, ReferenceId: String(documentId), Type: "WHATSAPP_SINGLE_DOCUMENT" }
        });

        // Automatically schedule follow-up for 'yira_appointment_book' template based on hospital settings
        this.scheduleAppointmentBookingFollowup(patientId, doc.HospitalId || 19, senderId);

        return {
            success: true,
            docCount,
            shareToken,
            shareLinkUrl,
            whatsappResult: result
        };
    }


    async notifyPatientMedicalRecord(patientId: string, senderId?: string): Promise<any> {
        const { userRepository } = await import("../../repositories/Account/user.repository.js");
        const { whatsappService } = await import("../Common/whatsapp.service.js");
        const { AppDataSource } = await import("../../config/database.js");
        const { AppNotification } = await import("../../models/Common/app-notification.model.js");

        const patient = await userRepository.findById(patientId);
        if (!patient) {
            throw new Error("Patient not found.");
        }
        const phone = patient.PhoneNumber;
        if (!phone) {
            throw new Error("Patient does not have a phone number registered.");
        }

        let normalizedPhone = phone.replace(/\D/g, "");
        if (normalizedPhone.length === 10) {
            normalizedPhone = `91${normalizedPhone}`;
        }

        const patientName = `${patient.FirstName || ""} ${patient.LastName || ""}`.trim() || "Valued Patient";

        const components = [
            {
                type: "body",
                parameters: [
                    { type: "text", text: patientName }
                ]
            }
        ];

        const result = await whatsappService.sendTemplateMessage(normalizedPhone, "medical_record", "en", components);

        // Save history record in AppNotifications (WHATSAPP_GENERAL_ALERT)
        const notifRepo = AppDataSource.getRepository(AppNotification);
        const notif = new AppNotification();
        notif.UserId = patientId;
        notif.SenderId = senderId || null;
        notif.Title = "General Alert: Medical Records Ready";
        notif.Body = `Sent general WhatsApp template ('medical_record') to ${normalizedPhone}`;
        notif.Type = "WHATSAPP_GENERAL_ALERT";
        notif.ReferenceId = patientId;
        notif.Route = "/patient/documents";
        notif.IsRead = false;
        notif.CreatedAt = new Date();
        await notifRepo.save(notif);

        const generalCount = await notifRepo.count({
            where: { UserId: patientId, Type: "WHATSAPP_GENERAL_ALERT" }
        });

        // Automatically schedule follow-up for 'yira_appointment_book' template based on hospital settings
        this.scheduleAppointmentBookingFollowup(patientId, 19, senderId);

        return {
            success: true,
            docCount: generalCount,
            notification: notif,
            whatsappResult: result
        };
    }

    async getNotificationHistory(patientId: string): Promise<any> {
        const { AppDataSource } = await import("../../config/database.js");
        const { AppNotification } = await import("../../models/Common/app-notification.model.js");
        const { In } = await import("typeorm");
        const notifRepo = AppDataSource.getRepository(AppNotification);

        const history = await notifRepo.find({
            where: { 
                UserId: patientId, 
                Type: In(["WHATSAPP_GENERAL_ALERT", "WHATSAPP_SINGLE_DOCUMENT", "WHATSAPP_MEDICAL_RECORD", "WHATSAPP_HOME_SAMPLE", "WHATSAPP_EYE_CONSULTATION", "WHATSAPP_DENTAL_CONSULTATION", "WHATSAPP_APPOINTMENT_BOOK", "WHATSAPP_APPOINTMENT_CANCEL"]) 
            },
            order: { CreatedAt: "DESC" },
            take: 100
        });

        const generalCount = history.filter(h => h.Type === "WHATSAPP_GENERAL_ALERT" || (h.Type === "WHATSAPP_MEDICAL_RECORD" && h.Title.includes("Ready"))).length;
        const documentShareCount = history.filter(h => h.Type === "WHATSAPP_SINGLE_DOCUMENT" || (h.Type === "WHATSAPP_MEDICAL_RECORD" && !h.Title.includes("Ready"))).length;
        const homeSampleCount = history.filter(h => h.Type === "WHATSAPP_HOME_SAMPLE").length;
        const eyeConsultationCount = history.filter(h => h.Type === "WHATSAPP_EYE_CONSULTATION").length;
        const dentalConsultationCount = history.filter(h => h.Type === "WHATSAPP_DENTAL_CONSULTATION").length;
        const appointmentBookCount = history.filter(h => h.Type === "WHATSAPP_APPOINTMENT_BOOK").length;
        const appointmentCancelCount = history.filter(h => h.Type === "WHATSAPP_APPOINTMENT_CANCEL").length;

        return {
            generalCount,
            documentShareCount,
            homeSampleCount,
            eyeConsultationCount,
            dentalConsultationCount,
            appointmentBookCount,
            appointmentCancelCount,
            count: history.length,
            history
        };
    }

    async uploadDocuments(data: any, files: Express.Multer.File[]): Promise<MedicalDocument[]> {
        const {
            appointmentId,
            patientId,
            doctorId,
            organizationId,
            hospitalId,
            documentCategory,
            category,
            documentType,
            description,
            tags,
            uploadedByUserId,
            isPatientUploaded,
            isDoctorUploaded
        } = data;

        if (!files || files.length === 0) {
            throw new Error("No document files uploaded.");
        }

        const validPatientId = ensureUUID(patientId);
        const validOrgId = Number(organizationId) || 1;
        let validHospId = Number(hospitalId);
        if (!validHospId || isNaN(validHospId)) {
            const { defaultOrganizationRepository } = await import("../../repositories/Organizations/default-organization.repository.js");
            const activeDefault = await defaultOrganizationRepository.getActiveDefault();
            validHospId = activeDefault?.HospitalId || 19;
        }
        const cat = documentCategory || category || "General";

        // 1. Upload to Azure Blob Storage
        let uploadResults: any[] = [];
        try {
            uploadResults = await blobService.uploadFiles(files, validPatientId, "medical-documents");
        } catch (azureErr: any) {
            console.error("[MedicalDocumentService] Azure upload warning, continuing with local metadata:", azureErr.message);
            uploadResults = files.map(f => ({
                fileName: f.originalname,
                fileUrl: "",
                fileType: f.originalname.substring(f.originalname.lastIndexOf(".")) || ".pdf"
            }));
        }

        const savedDocuments: MedicalDocument[] = [];

        // 2. Create records in database
        for (const res of uploadResults) {
            const document = new MedicalDocument();
            if (appointmentId && !isNaN(Number(appointmentId))) {
                document.AppointmentId = Number(appointmentId);
            }
            document.PatientId = validPatientId;
            if (doctorId && ensureUUID(doctorId) !== DEFAULT_UUID) {
                document.DoctorId = ensureUUID(doctorId);
            }
            document.OrganizationId = validOrgId;
            document.HospitalId = validHospId;
            document.DocumentCategory = cat;
            document.DocumentType = documentType || (res.fileType ? res.fileType.replace(".", "").toUpperCase() : "PDF");
            document.FileName = res.fileName;
            document.OriginalFileName = res.fileName;
            document.BlobUrl = res.fileUrl || "";
            document.MimeType = files.find(f => f.originalname === res.fileName)?.mimetype || "application/octet-stream";
            document.FileExtension = res.fileType || ".pdf";
            document.FileSize = files.find(f => f.originalname === res.fileName)?.size || 150000;
            document.Description = description;
            document.Tags = tags;
            if (uploadedByUserId && ensureUUID(uploadedByUserId) !== DEFAULT_UUID) {
                document.UploadedByUserId = ensureUUID(uploadedByUserId);
            }
            document.IsPatientUploaded = isPatientUploaded === "true" || isPatientUploaded === true;
            document.IsDoctorUploaded = isDoctorUploaded === "true" || isDoctorUploaded === true;
            document.IsSystemGenerated = false;
            document.CreatedBy = uploadedByUserId ? String(uploadedByUserId) : "System";

            try {
                const savedDoc = await medicalDocumentRepository.save(document);
                savedDocuments.push(savedDoc);
            } catch (dbErr: any) {
                console.error("[MedicalDocumentService] DB save warning:", dbErr.message);
                document.Id = Date.now();
                savedDocuments.push(document);
            }
        }

        // 3. Trigger Push Notification to Patient
        if (validPatientId && validPatientId !== DEFAULT_UUID && savedDocuments.length > 0) {
            try {
                const { pushNotificationService } = await import("../Notifications/push-notification.service.js");
                const { AppDataSource } = await import("../../config/database.js");
                const { User } = await import("../../models/Account/user.model.js");

                let doctorName = "Your doctor";
                if (doctorId && ensureUUID(doctorId) !== DEFAULT_UUID) {
                    const userRepo = AppDataSource.getRepository(User);
                    const doc = await userRepo.findOne({ where: { Id: doctorId } });
                    if (doc) doctorName = `${doc.FirstName || ""} ${doc.LastName || ""}`.trim();
                }

                await pushNotificationService.notifyMedicalRecordAdded({
                    patientId: validPatientId,
                    doctorId: doctorId || null,
                    doctorName,
                    recordName: savedDocuments[0]?.OriginalFileName || cat || "Medical Document",
                    appointmentId: appointmentId ? parseInt(String(appointmentId)) : undefined
                });
            } catch (notifErr: any) {
                console.error("[MedicalDocumentService] Push notification trigger warning:", notifErr?.message || notifErr);
            }

            // 4. Trigger Automatic Appointment Booking Link if enabled in HospitalSettings
            try {
                await this.triggerAutoBookingAfterDocument(validPatientId, validHospId, uploadedByUserId);
            } catch (autoErr: any) {
                console.error("[MedicalDocumentService] Auto-booking trigger warning:", autoErr?.message || autoErr);
            }
        }

        // 4. Automatically send Medical Document WhatsApp template to patient upon upload & maintain history & schedule 20-min booking follow-up
        const isDoctorOrStaff = (isDoctorUploaded === "true" || isDoctorUploaded === true) && (!isPatientUploaded || isPatientUploaded === "false");
        if (isDoctorOrStaff && savedDocuments.length > 0 && validPatientId && validPatientId !== DEFAULT_UUID) {
            for (const doc of savedDocuments) {
                if (doc && doc.Id) {
                    try {
                        await this.shareSingleDocument(Number(doc.Id), validPatientId, uploadedByUserId);
                        doc.WhatsAppSentCount = (Number(doc.WhatsAppSentCount) || 0) + 1;
                        console.log(`[MedicalDocumentService] ✅ Auto-shared uploaded document ${doc.Id} on WhatsApp to patient ${validPatientId}`);
                    } catch (autoErr: any) {
                        console.warn(`[MedicalDocumentService] ⚠️ Auto document ${doc.Id} WhatsApp send warning:`, autoErr?.message || autoErr);
                    }
                }
            }
        }

        return savedDocuments;
    }

    async getPatientDocuments(patientId: string, organizationId?: number, hospitalId?: number, appointmentId?: number, limit?: number): Promise<MedicalDocument[]> {
        const validPatientId = ensureUUID(patientId);
        if (validPatientId === DEFAULT_UUID) {
            return [];
        }
        try {
            return await medicalDocumentRepository.findByPatient(validPatientId, organizationId, hospitalId, appointmentId, limit);
        } catch (e: any) {
            console.error("[MedicalDocumentService] getPatientDocuments error:", e.message);
            return [];
        }
    }

    async deleteDocument(id: number, userId?: string): Promise<void> {
        try {
            await medicalDocumentRepository.softDelete(id, userId);
        } catch (e: any) {
            console.error("[MedicalDocumentService] deleteDocument error:", e.message);
        }
    }

    /**
     * Generate or retrieve an upload token & URL for an appointment
     */
    async generateUploadLink(appointmentId: number, createdBy?: string): Promise<any> {
        const appointment = await appointmentRepository.findById(appointmentId);
        if (!appointment) throw new Error("Appointment not found");

        const baseUrl = process.env.FRONTEND_URL || process.env.CLIENT_URL || "http://localhost:4200";
        const cleanBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

        // Check if an active link already exists
        let shareLink = await appointmentShareLinkRepository.findByAppointment(appointmentId);

        if (!shareLink || (shareLink.ExpiryAt && new Date(shareLink.ExpiryAt) < new Date())) {
            const shareToken = uuidv4();
            const shareLinkUrl = `${cleanBaseUrl}/upload-documents/${shareToken}`;

            shareLink = await appointmentShareLinkRepository.create({
                AppointmentId: appointmentId,
                PatientId: appointment.UserId,
                OrganizationId: appointment.OrgId,
                HospitalId: appointment.HospitalId,
                ShareToken: shareToken,
                ShareLink: shareLinkUrl,
                ExpiryAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
                IsActive: true,
                CreatedBy: createdBy || "SYSTEM"
            });
        }

        const patientName = appointment.User ? `${appointment.User.FirstName} ${appointment.User.LastName || ""}`.trim() : "Patient";
        const doctorName = appointment.Doctor ? `Dr. ${appointment.Doctor.FirstName} ${appointment.Doctor.LastName || ""}`.trim() : "Doctor";
        const hospitalName = appointment.Hospital?.Name || "Clinic";

        return {
            appointmentId: appointment.Id,
            shareToken: shareLink.ShareToken,
            shareLink: shareLink.ShareLink || `${cleanBaseUrl}/upload-documents/${shareLink.ShareToken}`,
            expiryAt: shareLink.ExpiryAt,
            patientName,
            doctorName,
            hospitalName,
            appointmentDate: appointment.AppointmentDate,
            startTime: appointment.StartTime
        };
    }

    /**
     * Get appointment summary and existing documents using an upload token (publicly accessible)
     */
    async getUploadLinkInfo(token: string): Promise<any> {
        const shareLink = await appointmentShareLinkRepository.findByToken(token);
        if (!shareLink) {
            throw new Error("Invalid or expired upload link.");
        }

        const appointment = await appointmentRepository.findById(Number(shareLink.AppointmentId));
        if (!appointment) {
            throw new Error("Associated appointment not found.");
        }

        // Fetch documents already uploaded for this appointment
        const existingDocs = await medicalDocumentRepository.findByAppointment(Number(appointment.Id));

        const patientName = appointment.User ? `${appointment.User.FirstName} ${appointment.User.LastName || ""}`.trim() : "Patient";
        const doctorName = appointment.Doctor ? `Dr. ${appointment.Doctor.FirstName} ${appointment.Doctor.LastName || ""}`.trim() : "Doctor";
        const hospitalName = appointment.Hospital?.Name || "Clinic";

        return {
            appointmentId: appointment.Id,
            shareToken: shareLink.ShareToken,
            patientId: appointment.UserId,
            patientName,
            doctorName,
            hospitalName,
            hospitalAddress: appointment.Hospital?.Address || "",
            appointmentDate: appointment.AppointmentDate,
            startTime: appointment.StartTime,
            appointmentType: appointment.AppointmentType || "In-Person",
            status: appointment.Status || "Scheduled",
            existingDocuments: existingDocs
        };
    }

    /**
     * Upload documents using a secure public upload token
     */
    async uploadDocumentsByLink(token: string, data: any, files: Express.Multer.File[]): Promise<MedicalDocument[]> {
        const shareLink = await appointmentShareLinkRepository.findByToken(token);
        if (!shareLink) {
            throw new Error("Invalid or expired upload link.");
        }

        const appointment = await appointmentRepository.findById(Number(shareLink.AppointmentId));
        if (!appointment) {
            throw new Error("Associated appointment not found.");
        }

        const uploadPayload = {
            ...data,
            appointmentId: appointment.Id,
            patientId: appointment.UserId,
            doctorId: appointment.DoctorId,
            organizationId: appointment.OrgId,
            hospitalId: appointment.HospitalId,
            uploadedByUserId: appointment.UserId,
            isPatientUploaded: true,
            isDoctorUploaded: false
        };

        return await this.uploadDocuments(uploadPayload, files);
    }
}

export const medicalDocumentService = new MedicalDocumentService();
