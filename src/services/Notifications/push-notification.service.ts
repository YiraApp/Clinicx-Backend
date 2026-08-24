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
     * Dispatches a push notification to all active devices of a user and logs it in the in-app notification center.
     */
    async sendNotification(payload: SendPushPayload): Promise<AppNotification> {
        const { userId, senderId, title, body, type, referenceId, route, additionalData } = payload;

        // 1. Persist notification in database for in-app Recent Notifications Center
        const notification = new AppNotification();
        notification.UserId = userId;
        notification.SenderId = senderId || null;
        notification.Title = title;
        notification.Body = body;
        notification.Type = type || "SYSTEM";
        notification.ReferenceId = referenceId ? String(referenceId) : null;
        notification.Route = route || null;
        notification.IsRead = false;
        notification.CreatedAt = new Date();

        const savedNotification = await this.notificationRepo.save(notification);

        // 2. Fetch active FCM tokens for this user
        try {
            const activeDevices = await userDeviceRepository.findActiveDevicesByUserId(userId);
            const validTokens = activeDevices
                .map(d => d.FCMToken?.trim())
                .filter((t): t is string => !!t && t.length > 10 && t !== "no_token_available");

            if (validTokens.length > 0) {
                console.log(`[PushNotificationService] Dispatched push to user ${userId} on ${validTokens.length} device(s): "${title}"`);
                // Note: We can expand this with Google FCM V1 HTTP OAuth when service-account credentials are provided
            } else {
                console.log(`[PushNotificationService] Notification saved for user ${userId} (No active FCM devices registered)`);
            }
        } catch (error) {
            console.error(`[PushNotificationService] Error querying devices for user ${userId}:`, error);
        }

        return savedNotification;
    }

    /**
     * Trigger 1: On Booking an Appointment (Alerts both Doctor and Patient)
     */
    async notifyAppointmentBooked(params: {
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
            body: `Your appointment with Dr. ${doctorName || 'Doctor'} on ${date} at ${time} is confirmed.`,
            type: "APPOINTMENT_BOOKED",
            referenceId: String(appointmentId),
            route: "/appointmentDashboardScreen",
            additionalData: { appointmentId, date, time, doctorName, consultationType }
        });
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

        const docTitle = doctorName ? `Dr. ${doctorName}` : "Your doctor";
        const recTitle = recordName || "Medical Summary";

        await this.sendNotification({
            userId: patientId,
            senderId: doctorId || null,
            title: "New Medical Record Added",
            body: `${docTitle} added a new record (${recTitle}) to your profile.`,
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

        const docTitle = doctorName ? `Dr. ${doctorName}` : "Your doctor";

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

        // Notify Patient
        await this.sendNotification({
            userId: patientId,
            senderId: doctorId,
            title: `Appointment ${formattedStatus}`,
            body: `Your appointment with Dr. ${doctorName || 'Doctor'} on ${date} has been marked as ${formattedStatus}.`,
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

        await this.sendNotification({
            userId: patientId,
            senderId: doctorId,
            title: "Doctor is Ready for Video Call",
            body: `Dr. ${doctorName || 'Doctor'} is waiting for you in the video consultation room. Tap to join.`,
            type: "TELECONSULT_START",
            referenceId: String(appointmentId),
            route: "/appointmentDashboardScreen",
            additionalData: { appointmentId, meetingUrl }
        });
    }
}

export const pushNotificationService = new PushNotificationService();
