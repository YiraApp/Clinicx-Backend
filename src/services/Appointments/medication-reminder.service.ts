import { AppDataSource } from "../../config/database.js";
import { PatientMedicationReminder } from "../../models/Appointments/patient-medication-reminder.model.js";
import { pushNotificationService } from "../Notifications/push-notification.service.js";

/**
 * Parses any 12-hour (e.g. "08:00 AM", "8:30 PM", "8:00am") or 24-hour (e.g. "14:30")
 * time string into 24-hour hour and minute integers.
 */
function parseTo24Hour(t: string): { hour: number; minute: number } | null {
    if (!t) return null;
    const clean = t.replace(/[\u202F\u00A0\s]+/g, " ").replace(/\./g, "").toUpperCase().trim();
    const match12 = clean.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
    if (match12) {
        let h = parseInt(match12[1], 10);
        const m = parseInt(match12[2], 10);
        const period = match12[3];
        if (period === "PM" && h < 12) h += 12;
        if (period === "AM" && h === 12) h = 0;
        return { hour: h, minute: m };
    }
    const match24 = clean.match(/^(\d{1,2}):(\d{2})$/);
    if (match24) {
        return { hour: parseInt(match24[1], 10), minute: parseInt(match24[2], 10) };
    }
    return null;
}

export class MedicationReminderService {
    // In-memory set to prevent duplicate push notifications in the same minute
    private sentPillReminders = new Set<string>();
    private cronInterval: NodeJS.Timeout | null = null;

    /**
     * Checks all active medication reminders against current IST (Indian Standard Time) and dispatches push notifications.
     */
    async checkAndSendDueReminders(): Promise<number> {
        try {
            if (!AppDataSource.isInitialized) return 0;

            const now = new Date();

            // 1. Calculate current IST date in YYYY-MM-DD format
            const istDateParts = new Intl.DateTimeFormat("en-US", {
                timeZone: "Asia/Kolkata",
                year: "numeric",
                month: "2-digit",
                day: "2-digit"
            }).formatToParts(now);

            const y = istDateParts.find(p => p.type === "year")?.value;
            const m = istDateParts.find(p => p.type === "month")?.value;
            const d = istDateParts.find(p => p.type === "day")?.value;
            const todayIstStr = `${y}-${m}-${d}`;

            // 2. Calculate current IST 24-hour hour & minute
            const istTimeParts = new Intl.DateTimeFormat("en-US", {
                timeZone: "Asia/Kolkata",
                hour: "numeric",
                minute: "numeric",
                hour12: false
            }).formatToParts(now);

            const istHour = parseInt(istTimeParts.find(p => p.type === "hour")?.value || "0", 10);
            const istMinute = parseInt(istTimeParts.find(p => p.type === "minute")?.value || "0", 10);

            const displayPeriod = istHour >= 12 ? "PM" : "AM";
            const displayHour12 = istHour % 12 === 0 ? 12 : istHour % 12;
            const displayTime12h = `${displayHour12.toString().padStart(2, "0")}:${istMinute.toString().padStart(2, "0")} ${displayPeriod}`;

            const repo = AppDataSource.getRepository(PatientMedicationReminder);
            const activeReminders = await repo.createQueryBuilder("r")
                .where("r.IsActive = 1")
                .andWhere("CAST(r.StartDate AS DATE) <= :today", { today: todayIstStr })
                .andWhere("(r.IsContinuous = 1 OR CAST(r.EndDate AS DATE) >= :today)", { today: todayIstStr })
                .getMany();

            let dispatchedCount = 0;

            for (const reminder of activeReminders) {
                let times: string[] = [];
                try {
                    times = JSON.parse(reminder.TimesJson || "[]");
                } catch {
                    times = [];
                }

                // Check if any scheduled time matches the current IST hour and minute
                const matchesTime = times.some(t => {
                    const parsed = parseTo24Hour(t);
                    return parsed !== null && parsed.hour === istHour && parsed.minute === istMinute;
                });

                if (matchesTime) {
                    const dedupeKey = `${reminder.Id}_${todayIstStr}_${istHour}_${istMinute}`;
                    if (!this.sentPillReminders.has(dedupeKey)) {
                        this.sentPillReminders.add(dedupeKey);

                        const dosageText = reminder.Dosage ? ` (${reminder.Dosage})` : "";
                        const mealText = reminder.MealRelation ? ` - ${reminder.MealRelation}` : "";

                        console.log(`[MedicationReminder] Auto-triggering IST pill alarm for ${reminder.MedicineName} to user ${reminder.UserId} at ${displayTime12h}`);

                        await pushNotificationService.sendNotification({
                            userId: reminder.UserId,
                            title: `💊 Time for your ${reminder.MedicineName}!`,
                            body: `Please take your scheduled dose${dosageText}${mealText}. Tap to log.`,
                            type: "MEDICATION_REMINDER",
                            referenceId: reminder.Id,
                            route: "/prescriptions",
                            additionalData: {
                                reminderId: reminder.Id,
                                medicineName: reminder.MedicineName,
                                dosage: reminder.Dosage,
                                mealRelation: reminder.MealRelation,
                                scheduledTime: displayTime12h,
                                date: todayIstStr
                            }
                        });

                        dispatchedCount++;
                    }
                }
            }

            // Periodically clear deduplication memory once it exceeds 2000 entries
            if (this.sentPillReminders.size > 2000) {
                this.sentPillReminders.clear();
            }

            return dispatchedCount;
        } catch (err: any) {
            console.error("[MedicationReminder] Error in checkAndSendDueReminders:", err.message || err);
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

        console.log(`[MedicationReminder] Background pill alarm scheduler started (checking every ${intervalSeconds}s in IST timezone)`);
        this.cronInterval = setInterval(() => {
            this.checkAndSendDueReminders();
        }, intervalSeconds * 1000);
    }

    /**
     * Stops the automated background scheduler
     */
    stopScheduler() {
        if (this.cronInterval) {
            clearInterval(this.cronInterval);
            this.cronInterval = null;
            console.log("[MedicationReminder] Background pill alarm scheduler stopped.");
        }
    }
}

export const medicationReminderService = new MedicationReminderService();
