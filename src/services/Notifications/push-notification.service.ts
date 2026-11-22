import { AppDataSource } from "../../config/database.js";
import { AppNotification } from "../../models/Common/app-notification.model.js";
import { findPrimaryOnSameNumber } from "../../utils/family-phone.js";
import { userDeviceRepository } from "../../MobileApi/v1/repositories/userdevice.repository.js";

/**
 * The patient's own appointments screen in the mobile app. Patient pushes must
 * not name "/appointmentDashboardScreen": that is the doctor's appointments
 * screen, and the app opens a push's route as-is when a tap starts it.
 */
const PATIENT_APPOINTMENTS_ROUTE = "/patientAppointments";

export interface SendPushPayload {
    userId: string;
    senderId?: string | null;
    title: string;
    body: string;
    type: string;
    referenceId?: string | null;
    route?: string | null;
    additionalData?: Record<string, any>;
    /**
     * false: only add it to the in-app notification list, without a push. For
     * messages that confirm something the person has just done themself.
     */
    push?: boolean;
    /**
     * false: push only to the person's own phones, not to their account holder's.
     * Use it when the account holder gets a message of their own about the same event.
     */
    includeAccountHolder?: boolean;
}

/** One push per phone per event: the same message to the same phone within this time is dropped. */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const recentPushes = new Map<string, number>();

/** Returns the tokens that haven't already had this message in the last few minutes, and records them. */
function dropRecentDuplicates(tokens: string[], eventKey: string): string[] {
    const now = Date.now();
    for (const [key, at] of recentPushes) {
        if (now - at > DUPLICATE_WINDOW_MS) recentPushes.delete(key);
    }
    return tokens.filter((token) => {
        const key = `${token}|${eventKey}`;
        if (recentPushes.has(key)) return false;
        recentPushes.set(key, now);
        return true;
    });
}

export class PushNotificationService {
    private notificationRepo = AppDataSource.getRepository(AppNotification);

    /**
     * Helper to validate if a string is a valid UUID/GUID
     */
    private isUuid(id?: string | null): id is string {
        return Boolean(id && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id.trim()));
    }

    /**
     * Works out who a notification is for. [userId] may be a user id, a patient
     * registration id, a phone number or an email.
     * - directIds: the accounts whose in-app notification list gets the message.
     * - deviceOwnerIds: the accounts whose phones get the push: the person and
     *   their account holder (the parent account of a dependent, or the primary
     *   account on the same phone number), since a dependent's notifications
     *   arrive on the phone of whoever manages them. Other family members are
     *   left out: a parent's own notifications must not reach a child's phone.
     */
    private async resolveRecipients(userId: string, includeAccountHolder: boolean): Promise<{ directIds: string[]; deviceOwnerIds: string[] }> {
        const directIds = new Set<string>();
        const holderIds = new Set<string>();
        if (!userId) return { directIds: [], deviceOwnerIds: [] };

        if (this.isUuid(userId)) directIds.add(userId);

        try {
            const { User } = await import("../../models/Account/user.model.js");
            const { PatientRegistration } = await import("../../models/Organizations/patient-registration.model.js");

            const userRepo = AppDataSource.getRepository(User);
            const regRepo = AppDataSource.getRepository(PatientRegistration);

            // A numeric id is a patient registration.
            if (/^\d+$/.test(String(userId).trim())) {
                const reg = await regRepo.findOne({ where: { Id: parseInt(userId, 10) } }).catch(() => null);
                if (reg?.UserId && this.isUuid(reg.UserId)) directIds.add(reg.UserId);
            }

            const user = await userRepo.createQueryBuilder("u")
                .where("u.Id = :id OR u.PhoneNumber = :phone OR u.Email = :email", { id: userId, phone: userId, email: userId })
                .getOne()
                .catch(() => null);

            if (user?.Id && this.isUuid(user.Id)) {
                directIds.add(user.Id);

                if (user.ParentUserId && this.isUuid(user.ParentUserId)) {
                    holderIds.add(user.ParentUserId);
                } else if (user.IsPrimary === false && user.PhoneNumber) {
                    const primary = await findPrimaryOnSameNumber(user).catch(() => null);
                    if (primary?.Id && this.isUuid(primary.Id)) holderIds.add(primary.Id);
                }
            }
        } catch (err) {
            console.error("[PushNotificationService] Error resolving notification recipients:", err);
        }

        const direct = Array.from(directIds).filter((id) => this.isUuid(id));
        const owners = new Set(direct.map((id) => id.toUpperCase()));
        if (includeAccountHolder) {
            for (const id of holderIds) owners.add(id.toUpperCase());
        }
        return { directIds: direct, deviceOwnerIds: Array.from(owners) };
    }

    /**
     * Adds a notification to the person's in-app list and pushes it to the phones
     * signed in to their account (and their account holder's, see resolveRecipients).
     * Phones whose account has no live session (signed out, or the session ran out)
     * get nothing, and a phone never gets the same message twice within a few minutes.
     */
    async sendNotification(payload: SendPushPayload): Promise<AppNotification> {
        const { userId, senderId, title, body, type, referenceId, route, additionalData } = payload;
        const shouldPush = payload.push !== false;

        const { directIds, deviceOwnerIds } = await this.resolveRecipients(userId, payload.includeAccountHolder !== false);
        console.log(`[PushNotificationService] Processing notification "${title}" for user "${userId}". In-app: [${directIds.join(', ')}], push to: [${shouldPush ? deviceOwnerIds.join(', ') : 'none'}]`);

        // 1. The in-app notification list
        let primarySaved: AppNotification | null = null;
        for (const uid of directIds) {
            try {
                const notification = new AppNotification();
                notification.UserId = uid;
                notification.SenderId = this.isUuid(senderId) ? senderId : null;
                notification.Title = title;
                notification.Body = body;
                notification.Type = type || "SYSTEM";
                notification.ReferenceId = referenceId ? String(referenceId) : null;
                notification.Route = route || null;
                notification.IsRead = false;
                notification.CreatedAt = new Date();

                const saved = await this.notificationRepo.save(notification);
                if (!primarySaved) {
                    primarySaved = saved;
                }
            } catch (err) {
                console.error(`[PushNotificationService] Error saving in-app notification for uid ${uid}:`, err);
            }
        }

        if (!shouldPush) {
            return primarySaved || new AppNotification();
        }

        // 2. The push, to phones with a live session only
        try {
            const devices = await userDeviceRepository.findPushableDevicesByUserIds(deviceOwnerIds);
            const tokens = Array.from(
                new Set(
                    devices
                        .map(d => d.FCMToken?.trim())
                        .filter((t): t is string => !!t && t.length > 10 && t !== "no_token_available")
                )
            );
            const eventKey = `${type || "SYSTEM"}|${referenceId ?? ""}|${title}`;
            const validTokens = dropRecentDuplicates(tokens, eventKey);
            if (validTokens.length < tokens.length) {
                console.log(`[PushNotificationService] Skipped ${tokens.length - validTokens.length} phone(s) that already had "${title}"`);
            }

            if (validTokens.length > 0) {
                console.log(`[PushNotificationService] Dispatched push to [${deviceOwnerIds.join(', ')}] on ${validTokens.length} device(s): "${title}"`);
                const { sendFcmPushToTokens } = await import("./firebase-admin.service.js");
                await sendFcmPushToTokens(validTokens, {
                    title,
                    body,
                    type,
                    route: route || undefined,
                    referenceId: referenceId || undefined,
                    additionalData
                });
            } else if (tokens.length === 0) {
                console.log(`[PushNotificationService] Notification saved for [${deviceOwnerIds.join(', ')}] (no signed-in phones)`);
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

        const forDependent = !!parentUserId && parentUserId.toUpperCase() !== String(patientId).toUpperCase();

        // 2. Notify Patient (a dependent's own phones only: the account holder gets message 3)
        await this.sendNotification({
            userId: patientId,
            senderId: doctorId,
            title: "Appointment Confirmed",
            body: `Your appointment with ${formattedDoctor} on ${date} at ${time} is confirmed.`,
            type: "APPOINTMENT_BOOKED",
            referenceId: String(appointmentId),
            route: "/patientDashboard",
            additionalData: { appointmentId, date, time, doctorName: formattedDoctor, consultationType },
            includeAccountHolder: !forDependent
        });

        // 3. If booking was made for a dependent, also notify Parent/Account holder
        if (forDependent && parentUserId) {
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
            additionalData: { patientId, appointmentId, recordName },
            // The patient uploaded it themself: list it, but don't push it to them.
            push: !isSelf
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
        parentUserId?: string | null;
        doctorName: string;
        patientName: string;
        date: string;
        status: string;
        /** The patient (or their family) made the change themself: list it, but don't push it to them. */
        changedByPatient?: boolean;
    }) {
        const { appointmentId, doctorId, patientId, parentUserId, doctorName, patientName, date, status, changedByPatient } = params;
        const push = !changedByPatient;

        const formattedStatus = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
        const formattedDoctor = this.formatDoctorName(doctorName);

        const forDependent = !!parentUserId && parentUserId.toUpperCase() !== String(patientId).toUpperCase();

        // Notify Patient (a dependent's own phones only: the account holder gets the next message)
        await this.sendNotification({
            userId: patientId,
            senderId: doctorId,
            title: `Appointment ${formattedStatus}`,
            body: `Your appointment with ${formattedDoctor} on ${date} has been marked as ${formattedStatus}.`,
            type: "APPOINTMENT_STATUS",
            referenceId: String(appointmentId),
            route: PATIENT_APPOINTMENTS_ROUTE,
            additionalData: { appointmentId, status, date },
            includeAccountHolder: !forDependent,
            push
        });

        // Notify Parent account if this is a dependent patient
        if (forDependent && parentUserId) {
            await this.sendNotification({
                userId: parentUserId,
                senderId: doctorId,
                title: `Appointment ${formattedStatus}`,
                body: `Appointment for ${patientName} with ${formattedDoctor} on ${date} has been marked as ${formattedStatus}.`,
                type: "APPOINTMENT_STATUS",
                referenceId: String(appointmentId),
                route: PATIENT_APPOINTMENTS_ROUTE,
                additionalData: { appointmentId, status, date, dependentId: patientId },
                push
            });
        }
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
            route: PATIENT_APPOINTMENTS_ROUTE,
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
                route: PATIENT_APPOINTMENTS_ROUTE,
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
            route: "/patientDoctorSuggestions",
            additionalData: { patientId, suggestionId, suggestionTitle }
        });
    }
}

export const pushNotificationService = new PushNotificationService();
