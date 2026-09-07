import { AppDataSource } from "../../config/database.js";
import { HospitalSetting } from "../../models/Organizations/hospital-settings.model.js";
import { HospitalSettingsHistory } from "../../models/Organizations/hospital-settings-history.model.js";
import { Hospital } from "../../models/Organizations/hospital.model.js";
import { HealthcareProvider } from "../../models/Organizations/healthcare-provider.model.js";
import { healthcareProviderService } from "./healthcare-provider.service.js";

export class HospitalSettingsService {
    private settingsRepo = AppDataSource.getRepository(HospitalSetting);
    private historyRepo = AppDataSource.getRepository(HospitalSettingsHistory);
    private hospitalRepo = AppDataSource.getRepository(Hospital);
    private providerRepo = AppDataSource.getRepository(HealthcareProvider);

    /**
     * Retrieve settings for a specific hospital.
     * STRICTLY READ-ONLY: Never creates or saves records to DB automatically.
     */
    async getSettings(hospitalId: number): Promise<HospitalSetting> {
        let setting = await this.settingsRepo.findOne({
            where: { HospitalId: hospitalId, IsDeleted: false }
        });

        if (!setting) {
            const hospital = await this.hospitalRepo.findOne({ where: { Id: hospitalId } });
            if (!hospital) {
                throw new Error(`Hospital with ID ${hospitalId} not found.`);
            }

            // Return in-memory default settings (All booleans false).
            // STRICTLY DO NOT PERSIST TO DATABASE! Nothing is saved until the user explicitly clicks "Save Settings".
            return {
                Id: 0,
                HospitalId: hospitalId,
                OrganizationId: hospital.OrganizationId,
                AutoSlotGeneration: false,
                AdvanceDays: 30,
                TakeBuffer: false,
                BufferMinutes: 0,
                AutoSyncDaily: false,
                OverwriteExisting: false,
                OnlinePayments: false,
                ConsultationFeeForPackages: false,
                HomeSample: false,
                DentalConsultation: false,
                EyeCare: false,
                NotifyTemplate: false,
                AdditionalFlags: null,
                Version: 0,
                IsActive: true,
                IsDeleted: false,
                CreatedAt: new Date(),
                UpdatedAt: new Date(),
                CreatedBy: null,
                UpdatedBy: null
            } as unknown as HospitalSetting;
        }

        return setting;
    }

    /**
     * Save hospital settings, increment version, and record full audit history.
     * ONLY executed when user explicitly clicks "Save Settings".
     */
    async saveSettings(hospitalId: number, data: Partial<HospitalSetting>, userContext?: any): Promise<HospitalSetting> {
        let existing = await this.settingsRepo.findOne({
            where: { HospitalId: hospitalId, IsDeleted: false }
        });

        const isNew = !existing;

        if (isNew) {
            const hospital = await this.hospitalRepo.findOne({ where: { Id: hospitalId } });
            if (!hospital) {
                throw new Error(`Hospital with ID ${hospitalId} not found.`);
            }

            const packageFeeVal = data.ConsultationFeeForPackages !== undefined 
                ? data.ConsultationFeeForPackages 
                : (data as any).consultationFeeForPackages;

            const newSetting = this.settingsRepo.create({
                HospitalId: hospitalId,
                OrganizationId: hospital.OrganizationId,
                AutoSlotGeneration: data.AutoSlotGeneration !== undefined ? Boolean(data.AutoSlotGeneration) : false,
                AdvanceDays: data.AdvanceDays !== undefined ? Number(data.AdvanceDays) : 30,
                TakeBuffer: data.TakeBuffer !== undefined ? Boolean(data.TakeBuffer) : false,
                BufferMinutes: data.BufferMinutes !== undefined ? Number(data.BufferMinutes) : 0,
                AutoSyncDaily: data.AutoSyncDaily !== undefined ? Boolean(data.AutoSyncDaily) : false,
                OverwriteExisting: data.OverwriteExisting !== undefined ? Boolean(data.OverwriteExisting) : false,
                OnlinePayments: data.OnlinePayments !== undefined ? Boolean(data.OnlinePayments) : false,
                ConsultationFeeForPackages: packageFeeVal !== undefined ? Boolean(packageFeeVal) : false,
                HomeSample: data.HomeSample !== undefined ? Boolean(data.HomeSample) : false,
                DentalConsultation: data.DentalConsultation !== undefined ? Boolean(data.DentalConsultation) : false,
                EyeCare: data.EyeCare !== undefined ? Boolean(data.EyeCare) : false,
                NotifyTemplate: data.NotifyTemplate !== undefined ? Boolean(data.NotifyTemplate) : false,
                AdditionalFlags: data.AdditionalFlags 
                    ? (typeof data.AdditionalFlags === "string" ? data.AdditionalFlags : JSON.stringify(data.AdditionalFlags)) 
                    : null,
                Version: 1,
                IsActive: true,
                IsDeleted: false,
                CreatedBy: userContext?.userId || null,
                UpdatedBy: userContext?.userId || null
            });

            const saved = await this.settingsRepo.save(newSetting);

            // Record initial audit history ONLY when explicitly saved
            const historyRecord = this.historyRepo.create({
                HospitalSettingId: saved.Id,
                HospitalId: hospitalId,
                OrganizationId: hospital.OrganizationId,
                Action: "CREATE",
                Version: 1,
                ChangedFields: "Initial Setup",
                OldValues: null,
                NewValues: JSON.stringify(saved),
                ChangedBy: userContext?.userId || null,
                ChangedByName: userContext?.userName || userContext?.name || null,
                ChangedByRole: userContext?.roleName || userContext?.role || null,
                ChangeReason: (data as any)["changeReason"] || (data as any)["ChangeReason"] || "Initial hospital settings configured",
                IpAddress: userContext?.ipAddress || null
            });
            await this.historyRepo.save(historyRecord);

            return saved;
        }

        // Updating existing setting
        const setting = existing;
        const oldSnapshot = {
            AutoSlotGeneration: setting.AutoSlotGeneration,
            AdvanceDays: setting.AdvanceDays,
            TakeBuffer: setting.TakeBuffer,
            BufferMinutes: setting.BufferMinutes,
            AutoSyncDaily: setting.AutoSyncDaily,
            OverwriteExisting: setting.OverwriteExisting,
            OnlinePayments: setting.OnlinePayments,
            ConsultationFeeForPackages: setting.ConsultationFeeForPackages,
            HomeSample: setting.HomeSample,
            DentalConsultation: setting.DentalConsultation,
            EyeCare: setting.EyeCare,
            NotifyTemplate: setting.NotifyTemplate,
            AdditionalFlags: setting.AdditionalFlags
        };

        const changedFields: string[] = [];

        if (data.AutoSlotGeneration !== undefined && Boolean(data.AutoSlotGeneration) !== setting.AutoSlotGeneration) {
            changedFields.push("AutoSlotGeneration");
            setting.AutoSlotGeneration = Boolean(data.AutoSlotGeneration);
        }
        if (data.AdvanceDays !== undefined && Number(data.AdvanceDays) !== setting.AdvanceDays) {
            changedFields.push("AdvanceDays");
            setting.AdvanceDays = Number(data.AdvanceDays);
        }
        if (data.TakeBuffer !== undefined && Boolean(data.TakeBuffer) !== setting.TakeBuffer) {
            changedFields.push("TakeBuffer");
            setting.TakeBuffer = Boolean(data.TakeBuffer);
        }
        if (data.BufferMinutes !== undefined && Number(data.BufferMinutes) !== setting.BufferMinutes) {
            changedFields.push("BufferMinutes");
            setting.BufferMinutes = Number(data.BufferMinutes);
        }
        if (data.AutoSyncDaily !== undefined && Boolean(data.AutoSyncDaily) !== setting.AutoSyncDaily) {
            changedFields.push("AutoSyncDaily");
            setting.AutoSyncDaily = Boolean(data.AutoSyncDaily);
        }
        if (data.OverwriteExisting !== undefined && Boolean(data.OverwriteExisting) !== setting.OverwriteExisting) {
            changedFields.push("OverwriteExisting");
            setting.OverwriteExisting = Boolean(data.OverwriteExisting);
        }
        if (data.OnlinePayments !== undefined && Boolean(data.OnlinePayments) !== setting.OnlinePayments) {
            changedFields.push("OnlinePayments");
            setting.OnlinePayments = Boolean(data.OnlinePayments);
        }
        const packageFeeVal = data.ConsultationFeeForPackages !== undefined 
            ? data.ConsultationFeeForPackages 
            : (data as any).consultationFeeForPackages;
        if (packageFeeVal !== undefined && Boolean(packageFeeVal) !== setting.ConsultationFeeForPackages) {
            changedFields.push("ConsultationFeeForPackages");
            setting.ConsultationFeeForPackages = Boolean(packageFeeVal);
        }
        if (data.HomeSample !== undefined && Boolean(data.HomeSample) !== setting.HomeSample) {
            changedFields.push("HomeSample");
            setting.HomeSample = Boolean(data.HomeSample);
        }
        if (data.DentalConsultation !== undefined && Boolean(data.DentalConsultation) !== setting.DentalConsultation) {
            changedFields.push("DentalConsultation");
            setting.DentalConsultation = Boolean(data.DentalConsultation);
        }
        if (data.EyeCare !== undefined && Boolean(data.EyeCare) !== setting.EyeCare) {
            changedFields.push("EyeCare");
            setting.EyeCare = Boolean(data.EyeCare);
        }
        if (data.NotifyTemplate !== undefined && Boolean(data.NotifyTemplate) !== setting.NotifyTemplate) {
            changedFields.push("NotifyTemplate");
            setting.NotifyTemplate = Boolean(data.NotifyTemplate);
        }
        if (data.AdditionalFlags !== undefined && data.AdditionalFlags !== setting.AdditionalFlags) {
            changedFields.push("AdditionalFlags");
            setting.AdditionalFlags = typeof data.AdditionalFlags === "string" 
                ? data.AdditionalFlags 
                : JSON.stringify(data.AdditionalFlags);
        }

        if (changedFields.length === 0) {
            return setting; // No change made
        }

        // Increment version number
        setting.Version = (setting.Version || 1) + 1;
        setting.UpdatedBy = userContext?.userId || null;

        await this.settingsRepo.save(setting);

        // Snapshot of new values
        const newSnapshot = {
            AutoSlotGeneration: setting.AutoSlotGeneration,
            AdvanceDays: setting.AdvanceDays,
            TakeBuffer: setting.TakeBuffer,
            BufferMinutes: setting.BufferMinutes,
            AutoSyncDaily: setting.AutoSyncDaily,
            OverwriteExisting: setting.OverwriteExisting,
            OnlinePayments: setting.OnlinePayments,
            ConsultationFeeForPackages: setting.ConsultationFeeForPackages,
            HomeSample: setting.HomeSample,
            DentalConsultation: setting.DentalConsultation,
            EyeCare: setting.EyeCare,
            NotifyTemplate: setting.NotifyTemplate,
            AdditionalFlags: setting.AdditionalFlags
        };

        // Save History Record
        const historyRecord = this.historyRepo.create({
            HospitalSettingId: setting.Id,
            HospitalId: hospitalId,
            OrganizationId: setting.OrganizationId,
            Action: "UPDATE",
            Version: setting.Version,
            ChangedFields: changedFields.join(", "),
            OldValues: JSON.stringify(oldSnapshot),
            NewValues: JSON.stringify(newSnapshot),
            ChangedBy: userContext?.userId || null,
            ChangedByName: userContext?.userName || userContext?.name || null,
            ChangedByRole: userContext?.roleName || userContext?.role || null,
            ChangeReason: (data as any)["changeReason"] || (data as any)["ChangeReason"] || `Updated ${changedFields.length} setting flag(s)`,
            IpAddress: userContext?.ipAddress || null
        });

        await this.historyRepo.save(historyRecord);

        return setting;
    }

    /**
     * Get settings change history for a hospital.
     */
    async getSettingsHistory(hospitalId: number, limit: number = 50): Promise<HospitalSettingsHistory[]> {
        return await this.historyRepo.find({
            where: { HospitalId: hospitalId },
            order: { CreatedAt: "DESC" },
            take: limit
        });
    }

    private schedulerInterval: NodeJS.Timeout | null = null;

    /**
     * Trigger immediate slot generation for all doctors in this hospital using the active hospital settings.
     * Iterates day-by-day to ensure existing slots on earlier days don't fail the rest of the window.
     */
    async triggerSlotGeneration(hospitalId: number): Promise<any> {
        const setting = await this.getSettings(hospitalId);

        if (!setting.AutoSlotGeneration) {
            throw new Error("Automatic slot generation is currently disabled for this hospital.");
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const advanceDays = Math.max(1, Number(setting.AdvanceDays || 30));
        const endDate = new Date(today);
        endDate.setDate(today.getDate() + advanceDays);

        const formatDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const startStr = formatDate(today);
        const endStr = formatDate(endDate);

        // Fetch all active doctors in this hospital
        const providers = await this.providerRepo.find({
            where: { HospitalId: hospitalId, IsDeleted: false, Status: true },
            relations: ["Availability"]
        });

        const effectiveBuffer = setting.TakeBuffer ? Number(setting.BufferMinutes || 0) : 0;
        const results = [];

        for (const doctor of providers) {
            if (doctor.Availability && doctor.Availability.length > 0) {
                let doctorSlotsCount = 0;
                let dayErrors = 0;
                let currentDate = new Date(today);

                while (currentDate <= endDate) {
                    const dateStr = formatDate(currentDate);
                    try {
                        const res = await healthcareProviderService.generateSlotsForDateRange(
                            doctor.Id,
                            hospitalId,
                            dateStr,
                            dateStr,
                            15, // standard 15m slot duration
                            effectiveBuffer,
                            setting.OverwriteExisting
                        );
                        doctorSlotsCount += (res?.count || 0);
                    } catch (err: any) {
                        if (err.message === "SLOTS_ALREADY_EXIST") {
                            // Already generated for this day, safely skip to preserve existing bookings
                        } else {
                            dayErrors++;
                        }
                    }
                    currentDate.setDate(currentDate.getDate() + 1);
                }

                results.push({
                    doctorId: doctor.Id,
                    doctorName: (doctor as any).Name || (doctor.User ? `${doctor.User.FirstName || ""} ${doctor.User.LastName || ""}`.trim() : `Doctor #${doctor.Id}`),
                    count: doctorSlotsCount,
                    success: true,
                    hadErrors: dayErrors > 0
                });
            }
        }

        const totalSlotsGenerated = results.filter(r => r.success).reduce((acc, r) => acc + (r.count || 0), 0);

        return {
            hospitalId,
            advanceDays: setting.AdvanceDays,
            startDate: startStr,
            endDate: endStr,
            bufferApplied: effectiveBuffer,
            takeBuffer: setting.TakeBuffer,
            doctorsProcessed: providers.length,
            totalSlotsGenerated,
            details: results
        };
    }

    /**
     * Start background slot scheduler (runs every 6 hours to keep rolling slots generated for all active hospitals)
     */
    startDailySlotScheduler(intervalHours: number = 6) {
        if (this.schedulerInterval) {
            clearInterval(this.schedulerInterval);
        }

        console.log(`[HospitalSettings] Background auto-slot scheduler started (syncs every ${intervalHours}h)`);

        // Run an initial sync 15 seconds after server startup
        setTimeout(() => {
            this.runAutoSyncForAllHospitals().catch(err => {
                console.error("[HospitalSettings] Error in initial slot sync:", err.message);
            });
        }, 15000);

        // Run periodically
        this.schedulerInterval = setInterval(() => {
            this.runAutoSyncForAllHospitals().catch(err => {
                console.error("[HospitalSettings] Error in scheduled slot sync:", err.message);
            });
        }, intervalHours * 60 * 60 * 1000);
    }

    /**
     * Run slot generation for all hospitals that have AutoSlotGeneration and AutoSyncDaily enabled
     */
    async runAutoSyncForAllHospitals() {
        try {
            const activeSettings = await this.settingsRepo.find({
                where: { AutoSlotGeneration: true, AutoSyncDaily: true, IsActive: true, IsDeleted: false }
            });

            if (activeSettings.length === 0) {
                return;
            }

            console.log(`[HospitalSettings] Running scheduled auto-slot sync for ${activeSettings.length} active hospital(s)...`);

            for (const setting of activeSettings) {
                try {
                    const res = await this.triggerSlotGeneration(setting.HospitalId);
                    console.log(`[HospitalSettings] Auto-synced Hospital #${setting.HospitalId}: ${res.totalSlotsGenerated} slots generated across ${res.doctorsProcessed} doctor(s).`);
                } catch (err: any) {
                    console.error(`[HospitalSettings] Auto-sync failed for Hospital #${setting.HospitalId}:`, err.message);
                }
            }
        } catch (error: any) {
            console.error("[HospitalSettings] Failed to fetch active settings for auto-sync:", error.message);
        }
    }
}

export const hospitalSettingsService = new HospitalSettingsService();
