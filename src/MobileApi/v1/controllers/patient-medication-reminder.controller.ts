import { Request, Response } from "express";
import { patientMedicationReminderRepository } from "../../../repositories/Appointments/patient-medication-reminder.repository.js";
import { ApiResponse } from "../../../utils/response.utils.js";

export class PatientMedicationReminderController {
    /**
     * Save or update a medication reminder
     * POST /v1/api/auth/patient/medication-reminders
     */
    async saveReminder(req: Request, res: Response): Promise<Response> {
        try {
            const userId = (req as any).user?.userId || req.body.userId;
            if (!userId) {
                return res.status(400).json(ApiResponse.error("User ID is required"));
            }

            const {
                id,
                prescriptionId,
                medicineName,
                dosage,
                instructions,
                mealRelation,
                times,
                timesJson,
                startDate,
                endDate,
                durationDays,
                isContinuous,
                doctorName,
                doctorPhoto,
                condition,
                isActive
            } = req.body;

            if (!medicineName || (!times && !timesJson)) {
                return res.status(400).json(ApiResponse.error("Medicine name and reminder times are required"));
            }

            // Normalize times array to JSON string
            let finalTimesJson = "[]";
            if (Array.isArray(times)) {
                finalTimesJson = JSON.stringify(times);
            } else if (typeof timesJson === "string") {
                finalTimesJson = timesJson;
            } else if (typeof times === "string") {
                finalTimesJson = times;
            }

            const reminderId = id || `med_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

            // Normalize dates to YYYY-MM-DD
            const start = startDate ? new Date(startDate).toISOString().split("T")[0] : new Date().toISOString().split("T")[0];
            const end = endDate ? new Date(endDate).toISOString().split("T")[0] : new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];

            const saved = await patientMedicationReminderRepository.saveReminder({
                Id: reminderId,
                UserId: userId,
                PrescriptionId: prescriptionId || null,
                MedicineName: medicineName,
                Dosage: dosage || null,
                Instructions: instructions || null,
                MealRelation: mealRelation || null,
                TimesJson: finalTimesJson,
                StartDate: start,
                EndDate: end,
                DurationDays: durationDays !== undefined ? Number(durationDays) : 1,
                IsContinuous: isContinuous === true || isContinuous === "true" || isContinuous === 1,
                DoctorName: doctorName || null,
                DoctorPhoto: doctorPhoto || null,
                Condition: condition || null,
                IsActive: isActive !== false && isActive !== "false" && isActive !== 0,
                UpdatedAt: new Date()
            });

            return res.status(200).json(ApiResponse.success(saved, "Medication reminder saved successfully"));
        } catch (error: any) {
            console.error("❌ Error saving medication reminder:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to save medication reminder"));
        }
    }

    /**
     * Get all active medication reminders for the authenticated patient
     * GET /v1/api/auth/patient/medication-reminders
     */
    async getReminders(req: Request, res: Response): Promise<Response> {
        try {
            const userId = (req as any).user?.userId || (req.query.userId as string);
            if (!userId) {
                return res.status(400).json(ApiResponse.error("User ID is required"));
            }

            const reminders = await patientMedicationReminderRepository.findActiveByUserId(userId);

            // Format for client consumption (parse TimesJson to times list)
            const formatted = reminders.map(r => {
                let timesList: string[] = [];
                try {
                    timesList = JSON.parse(r.TimesJson || "[]");
                } catch {
                    timesList = [];
                }
                return {
                    id: r.Id,
                    prescriptionId: r.PrescriptionId,
                    medicineName: r.MedicineName,
                    dosage: r.Dosage,
                    instructions: r.Instructions,
                    mealRelation: r.MealRelation,
                    times: timesList,
                    timingSlots: timesList,
                    startDate: r.StartDate,
                    endDate: r.EndDate,
                    durationDays: r.DurationDays,
                    isContinuous: Boolean(r.IsContinuous),
                    doctorName: r.DoctorName,
                    doctorPhoto: r.DoctorPhoto,
                    condition: r.Condition,
                    isActive: Boolean(r.IsActive),
                    createdAt: r.CreatedAt,
                    updatedAt: r.UpdatedAt
                };
            });

            return res.status(200).json(ApiResponse.success(formatted, "Medication reminders retrieved successfully"));
        } catch (error: any) {
            console.error("❌ Error fetching medication reminders:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to fetch medication reminders"));
        }
    }

    /**
     * Delete / deactivate a medication reminder
     * DELETE /v1/api/auth/patient/medication-reminders/:id
     */
    async deleteReminder(req: Request, res: Response): Promise<Response> {
        try {
            const userId = (req as any).user?.userId || req.body?.userId;
            const reminderId = String(req.params.id);

            if (!userId || !reminderId) {
                return res.status(400).json(ApiResponse.error("User ID and Reminder ID are required"));
            }

            await patientMedicationReminderRepository.deactivateReminder(reminderId, userId);
            return res.status(200).json(ApiResponse.success(null, "Medication reminder deleted successfully"));
        } catch (error: any) {
            console.error("❌ Error deleting medication reminder:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to delete medication reminder"));
        }
    }

    /**
     * Batch sync reminders from mobile device
     * POST /v1/api/auth/patient/medication-reminders/sync
     */
    async syncReminders(req: Request, res: Response): Promise<Response> {
        try {
            const userId = (req as any).user?.userId || req.body.userId;
            const reminders = req.body.reminders || [];

            if (!userId) {
                return res.status(400).json(ApiResponse.error("User ID is required"));
            }

            if (!Array.isArray(reminders)) {
                return res.status(400).json(ApiResponse.error("Reminders must be an array"));
            }

            const savedResults = [];
            for (const item of reminders) {
                if (!item.medicineName) continue;

                let finalTimesJson = "[]";
                if (Array.isArray(item.times)) {
                    finalTimesJson = JSON.stringify(item.times);
                } else if (typeof item.timesJson === "string") {
                    finalTimesJson = item.timesJson;
                }

                const reminderId = item.id || `med_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
                const start = item.startDate ? new Date(item.startDate).toISOString().split("T")[0] : new Date().toISOString().split("T")[0];
                const end = item.endDate ? new Date(item.endDate).toISOString().split("T")[0] : new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];

                const saved = await patientMedicationReminderRepository.saveReminder({
                    Id: reminderId,
                    UserId: userId,
                    PrescriptionId: item.prescriptionId || null,
                    MedicineName: item.medicineName,
                    Dosage: item.dosage || null,
                    Instructions: item.instructions || null,
                    MealRelation: item.mealRelation || null,
                    TimesJson: finalTimesJson,
                    StartDate: start,
                    EndDate: end,
                    DurationDays: item.durationDays !== undefined ? Number(item.durationDays) : 1,
                    IsContinuous: item.isContinuous === true || item.isContinuous === "true" || item.isContinuous === 1,
                    DoctorName: item.doctorName || null,
                    DoctorPhoto: item.doctorPhoto || null,
                    Condition: item.condition || null,
                    IsActive: item.isActive !== false && item.isActive !== "false" && item.isActive !== 0,
                    UpdatedAt: new Date()
                });
                savedResults.push(saved);
            }

            return res.status(200).json(ApiResponse.success(savedResults, `${savedResults.length} reminders synced successfully`));
        } catch (error: any) {
            console.error("❌ Error syncing medication reminders:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to sync medication reminders"));
        }
    }
}

export const patientMedicationReminderController = new PatientMedicationReminderController();
