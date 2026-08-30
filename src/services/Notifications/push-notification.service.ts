import { AppDataSource } from "../../config/database.js";
import { AppNotification } from "../../models/Common/app-notification.model.js";
import { userDeviceRepository } from "../../MobileApi/v1/repositories/userdevice.repository.js";

export interface SendPushPayload {
    userId: string;
    senderId?: string | null;
    title: string;
    body: string;
    type: string;
    referenceId?: string | null;
    route?: string | null;
    additionalData?: Record<string, any>;
}

export class PushNotificationService {
    private notificationRepo = AppDataSource.getRepository(AppNotification);

    /**
     * Resolves all candidate and linked family user identifiers (Primary account + all linked dependents, up to 6 accounts)
     */
    private async resolveActualUserIds(userId: string): Promise<{ directIds: string[]; familyMemberIds: string[] }> {
        const directIds = new Set<string>();
        const familyMemberIds = new Set<string>();
        if (!userId) return { directIds: [], familyMemberIds: [] };

        directIds.add(userId);
        familyMemberIds.add(userId);

        try {
            const { User } = await import("../../models/Account/user.model.js");
            const { PatientRegistration } = await import("../../models/Organizations/patient-registration.model.js");

            const userRepo = AppDataSource.getRepository(User);
            const regRepo = AppDataSource.getRepository(PatientRegistration);

            // 1. If numeric or integer ID, check PatientRegistration by Id
            const numId = parseInt(userId, 10);
            if (!isNaN(numId)) {
                const reg = await regRepo.findOne({ where: { Id: numId } }).catch(() => null);
                if (reg?.UserId) {
                    directIds.add(reg.UserId);
                    familyMemberIds.add(reg.UserId);
                }
            }

            // 2. Check User by Id (UUID), PhoneNumber, or Email
            let user = await userRepo.createQueryBuilder("u")
                .where("u.Id = :id OR u.PhoneNumber = :phone OR u.Email = :email", {
                    id: userId,
                    phone: userId,
                    email: userId
                })
                .getOne()
                .catch(() => null);

            if (user?.Id) {
                directIds.add(user.Id);
                familyMemberIds.add(user.Id);
            }

            // 3. Check PatientRegistrations pointing to this user
            const patientRegs = await regRepo.find({ where: { UserId: userId } }).catch(() => []);
            for (const r of patientRegs) {
                if (r.UserId) {
                    directIds.add(r.UserId);
                    familyMemberIds.add(r.UserId);
                }
                directIds.add(String(r.Id));
            }

            // 4. Resolve ALL linked family members / dependents (up to 6 accounts linked to same family/device)
            if (user) {
                const cleanPhone = user.PhoneNumber ? user.PhoneNumber.replace(/\D/g, '').slice(-10) : '';
                const parentId = user.ParentUserId || user.Id;

                if (user.ParentUserId) {
                    familyMemberIds.add(user.ParentUserId);
                }

                const familyMembers = await userRepo.createQueryBuilder('u')
                    .where('u.IsDeleted = 0')
                    .andWhere(
                        '(u.Id = :userId OR u.Id = :parentId OR u.ParentUserId = :parentId OR u.ParentUserId = :userId' +
                        (cleanPhone && cleanPhone.length === 10 ? ' OR RIGHT(REPLACE(u.PhoneNumber, \' \', \'\'), 10) = :cleanPhone' : '') + ')',
                        { userId: user.Id, parentId, cleanPhone }
                    )
                    .getMany()
                    .catch(() => []);

                for (const m of familyMembers) {
                    familyMemberIds.add(m.Id);
                }
            }
        } catch (err) {
            console.error("[PushNotificationService] Error resolving family user IDs:", err);
        }

        return {
            directIds: Array.from(directIds),
            familyMemberIds: Array.from(familyMemberIds)
        };
    }

    /**
     * Dispatches a push notification to all active devices of a user and all linked family accounts, and logs it in the in-app notification center.
     */
    async sendNotification(payload: SendPushPayload): Promise<AppNotification> {
        const { userId, senderId, title, body, type, referenceId, route, additionalData } = payload;

        const { directIds, familyMemberIds } = await this.resolveActualUserIds(userId);
        console.log(`[PushNotificationService] Processing notification "${title}" for user "${userId}". Direct IDs: [${directIds.join(', ')}], Family IDs: [${familyMemberIds.join(', ')}]`);

        // 1. Persist notification in database for in-app Recent Notifications Center for all direct candidate IDs
        let primarySaved: AppNotification | null = null;
        for (const uid of directIds) {
            try {
                const notification = new AppNotification();
                notification.UserId = uid;
                notification.SenderId = senderId || null;
                notification.Title = title;
                notification.Body = body;
                notification.Type = type || "SYSTEM";
                notification.ReferenceId = referenceId ? String(referenceId) : null;
                notification.Route = route || null;
                notification.IsRead = false;
                notification.CreatedAt = new Date();

                const saved = await this.notificationRepo.save(notification);
                if (!primarySaved || uid.length > 20) {
                    primarySaved = saved;
                }
            } catch (err) {
                console.error(`[PushNotificationService] Error saving in-app notification for uid ${uid}:`, err);
            }
        }

        // 2. Fetch active FCM tokens across all linked family member devices (primary account + dependents)
        try {
            const allDevices: any[] = [];
            for (const uid of familyMemberIds) {
                const devs = await userDeviceRepository.findActiveDevicesByUserId(uid);
                if (devs && devs.length > 0) {
                    allDevices.push(...devs);
                }
            }

            const validTokens = Array.from(
                new Set(
                    allDevices
                        .map(d => d.FCMToken?.trim())
                        .filter((t): t is string => !!t && t.length > 10 && t !== "no_token_available")
                )
            );

            if (validTokens.length > 0) {
                console.log(`[PushNotificationService] Dispatched push to family [${familyMemberIds.join(', ')}] on ${validTokens.length} device(s): "${title}"`);
                const { sendFcmPushToTokens } = await import("./firebase-admin.service.js");
                await sendFcmPushToTokens(validTokens, {
                    title,
                    body,
                    type,
                    route: route || undefined,
                    referenceId: referenceId || undefined,
                    additionalData
                });
            } else {
                console.log(`[PushNotificationService] Notification saved for family [${familyMemberIds.join(', ')}] (No active FCM device tokens registered)`);
            }
        } catch (error) {
            console.error(`[PushNotificationService] Error querying devices for user ${userId}:`, error);
        }

        return primarySaved || new AppNotification();
    }

    /**
     * Helper to safely format doctor name without duplicate 'Dr. Dr.' prefixes
     */
    private formatDoctorName(name?: string): string {
        if (!name || !name.trim()) return "Doctor";
        const clean = name.trim().replace(/^(dr\.|dr\s+|doctor\s+)/i, "").trim();
        return clean ? `Dr. ${clean}` : "Doctor";
    }

    /**
     * Trigger 1: On Appointment Booking (Dispatched to both Doctor and Patient)
     */
    async notifyAppointmentBooked(params: {
        appointmentId: string | number;
        doctorId: string;
        patientId: string;
        parentUserId?: string | null;
        doctorName: string;
        patientName: string;
        date: string;
        time: string;
        consultationType?: string;
    }) {
        const { appointmentId, doctorId, patientId, parentUserId, doctorName, patientName, date, time, consultationType } = params;
        const formattedDoctor = this.formatDoctorName(doctorName);

        // 1. Notify Doctor
        await this.sendNotification({
            userId: doctorId,
            senderId: patientId,
            title: "New Appointment Booked",
            body: `${patientName || 'A patient'} booked an appointment for ${date} at ${time}.`,
            type: "APPOINTMENT_BOOKED",
            referenceId: String(appointmentId),
            route: "/doctorDashboard",
            additionalData: { appointmentId, date, time, patientName, consultationType }
        });

        // 2. Notify Patient
        await this.sendNotification({
            userId: patientId,
            senderId: doctorId,
            title: "Appointment Confirmed",
            body: `Your appointment with ${formattedDoctor} on ${date} at ${time} is confirmed.`,
            type: "APPOINTMENT_BOOKED",
            referenceId: String(appointmentId),
            route: "/patientDashboard",
            additionalData: { appointmentId, date, time, doctorName: formattedDoctor, consultationType }
        });

        // 3. If booking was made for a dependent, also notify Parent/Account holder
        if (parentUserId && parentUserId !== patientId) {
            await this.sendNotification({
                userId: parentUserId,
                senderId: doctorId,
                title: "Appointment Confirmed",
                body: `Appointment for ${patientName} with ${formattedDoctor} on ${date} at ${time} is confirmed.`,
                type: "APPOINTMENT_BOOKED",
                referenceId: String(appointmentId),
                route: "/patientDashboard",
                additionalData: { appointmentId, date, time, doctorName: formattedDoctor, patientName, consultationType }
            });
        }
    }

    /**
     * Trigger 2: On Adding/Uploading Records to an Appointment (Alerts Patient)
     */
    async notifyMedicalRecordAdded(params: {
        patientId: string;
        doctorId?: string;
        doctorName?: string;
        recordName?: string;
        appointmentId?: string | number;
    }) {
        const { patientId, doctorId, doctorName, recordName, appointmentId } = params;

        const isSelf = Boolean(!doctorId || (doctorId && doctorId === patientId) || (doctorName && doctorName.toLowerCase() === "patient"));
        const formattedDoc = this.formatDoctorName(doctorName);
        const docTitle = isSelf ? "You" : formattedDoc;
        const recTitle = recordName || "Medical Summary";

        const body = `${docTitle} added a new record (${recTitle}) to your profile.`;

        await this.sendNotification({
            userId: patientId,
            senderId: isSelf ? null : (doctorId || null),
            title: isSelf ? "Health Record Added" : "New Medical Record Added",
            body,
            type: "MEDICAL_RECORD_ADDED",
            referenceId: appointmentId ? String(appointmentId) : null,
            route: "/userTestResultScreen",
            additionalData: { patientId, appointmentId, recordName }
        });
    }

    /**
     * Trigger 3: On Prescription Added/Issued (Alerts Patient)
     */
    async notifyPrescriptionAdded(params: {
        patientId: string;
        doctorId?: string;
        doctorName?: string;
        appointmentId?: string | number;
        prescriptionId?: string | number;
    }) {
        const { patientId, doctorId, doctorName, appointmentId, prescriptionId } = params;

        const docTitle = this.formatDoctorName(doctorName);

        await this.sendNotification({
            userId: patientId,
            senderId: doctorId || null,
            title: "New Prescription Issued",
            body: `${docTitle} has issued a new prescription for your consultation.`,
            type: "PRESCRIPTION_ADDED",
            referenceId: prescriptionId ? String(prescriptionId) : (appointmentId ? String(appointmentId) : null),
            route: "/userPrescriptionManagement",
            additionalData: { patientId, appointmentId, prescriptionId }
        });
    }

    /**
     * Trigger 4: On Appointment Status Updates (Completed, Cancelled, etc.)
     */
    async notifyAppointmentStatusChanged(params: {
        appointmentId: string | number;
        doctorId: string;
        patientId: string;
        doctorName: string;
        patientName: string;
        date: string;
        status: string;
    }) {
        const { appointmentId, doctorId, patientId, doctorName, patientName, date, status } = params;

        const formattedStatus = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
        const formattedDoctor = this.formatDoctorName(doctorName);

        // Notify Patient
        await this.sendNotification({
            userId: patientId,
            senderId: doctorId,
            title: `Appointment ${formattedStatus}`,
            body: `Your appointment with ${formattedDoctor} on ${date} has been marked as ${formattedStatus}.`,
            type: "APPOINTMENT_STATUS",
            referenceId: String(appointmentId),
            route: "/appointmentDashboardScreen",
            additionalData: { appointmentId, status, date }
        });
    }

    /**
     * Trigger 5: On Teleconsultation Video Meeting Ready
     */
    async notifyTeleconsultReady(params: {
        patientId: string;
        doctorId: string;
        doctorName: string;
        appointmentId: string | number;
        meetingUrl?: string;
    }) {
        const { patientId, doctorId, doctorName, appointmentId, meetingUrl } = params;
        const formattedDoctor = this.formatDoctorName(doctorName);

        await this.sendNotification({
            userId: patientId,
            senderId: doctorId,
            title: "Doctor is Ready for Video Call",
            body: `${formattedDoctor} is waiting for you in the video consultation room. Tap to join.`,
            type: "TELECONSULT_START",
            referenceId: String(appointmentId),
            route: "/appointmentDashboardScreen",
            additionalData: { appointmentId, meetingUrl }
        });
    }

    /**
     * Trigger 6: 10-Minute Pre-Appointment Reminder (Dispatched to both Doctor and Patient)
     */
    async notifyAppointment10MinReminder(params: {
        appointmentId: string | number;
        doctorId: string;
        patientId: string;
        doctorName: string;
        patientName: string;
        date: string;
        time: string;
        consultationType?: string;
    }) {
        const { appointmentId, doctorId, patientId, doctorName, patientName, date, time, consultationType } = params;
        const formattedDoctor = this.formatDoctorName(doctorName);

        // 1. Alert Doctor
        if (doctorId) {
            await this.sendNotification({
                userId: doctorId,
                senderId: patientId || null,
                title: "⏰ Upcoming Consultation in 10 Mins",
                body: `Your appointment with ${patientName || 'Patient'} starts in 10 minutes (${time}).`,
                type: "APPOINTMENT_REMINDER_10MIN",
                referenceId: String(appointmentId),
                route: "/doctorDashboard",
                additionalData: { appointmentId, date, time, patientName, consultationType }
            });
        }

        // 2. Alert Patient
        if (patientId) {
            await this.sendNotification({
                userId: patientId,
                senderId: doctorId || null,
                title: "⏰ Appointment in 10 Minutes",
                body: `Your consultation with ${formattedDoctor} starts at ${time}. Please be ready.`,
                type: "APPOINTMENT_REMINDER_10MIN",
                referenceId: String(appointmentId),
                route: "/appointmentDashboardScreen",
                additionalData: { appointmentId, date, time, doctorName: formattedDoctor, consultationType }
            });
        }
    }

    /**
     * Trigger 7: On Doctor Suggestion Added (Alerts Patient)
     */
    async notifyDoctorSuggestionAdded(params: {
        patientId: string;
        doctorId?: string;
        doctorName?: string;
        suggestionTitle: string;
        suggestionId?: string | number;
    }) {
        const { patientId, doctorId, doctorName, suggestionTitle, suggestionId } = params;
        const formattedDoctor = this.formatDoctorName(doctorName);

        await this.sendNotification({
            userId: patientId,
            senderId: doctorId || null,
            title: "New Doctor Suggestion",
            body: `${formattedDoctor} has added a new suggestion for you: "${suggestionTitle}"`,
            type: "DOCTOR_SUGGESTION",
            referenceId: suggestionId ? String(suggestionId) : null,
            route: "/patientDashboard",
            additionalData: { patientId, suggestionId, suggestionTitle }
        });
    }
}

export const pushNotificationService = new PushNotificationService();
