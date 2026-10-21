import { pushCampaignRepository } from "../../repositories/Notifications/push-campaign.repository.js";
import { PushCampaign } from "../../models/Notifications/push-campaign.model.js";

export class PushCampaignService {
    private schedulerInterval: NodeJS.Timeout | null = null;

    private getISTTime(date: Date = new Date()): string {
        try {
            return date.toLocaleTimeString("en-GB", {
                timeZone: "Asia/Kolkata",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            });
        } catch {
            const hours = String(date.getHours()).padStart(2, "0");
            const minutes = String(date.getMinutes()).padStart(2, "0");
            return `${hours}:${minutes}`;
        }
    }

    private formatCampaign(c: PushCampaign) {
        let displayScheduledTime = c.ScheduledTime || null;
        if (c.ScheduleType === "now") {
            if (c.LastSentAt) {
                displayScheduledTime = this.getISTTime(new Date(c.LastSentAt));
            } else if (!c.ScheduledTime || c.ScheduledTime === "10:00") {
                displayScheduledTime = null;
            }
        }

        return {
            id: c.Id,
            title: c.Title,
            body: c.Body,
            imageUrl: c.ImageUrl || null,
            hasImage: c.HasImage,
            scheduleType: c.ScheduleType,
            scheduledDate: c.ScheduledDate ? new Date(c.ScheduledDate).toISOString().slice(0, 10) : null,
            scheduledTime: displayScheduledTime,
            recurringPattern: c.RecurringPattern || null,
            recurringDays: c.RecurringDays || null,
            redirectionType: c.RedirectionType,
            redirectionUrl: c.RedirectionUrl || null,
            inAppRoute: c.InAppRoute || "/patientDashboard",
            inAppParams: c.InAppParams ? (typeof c.InAppParams === "string" ? JSON.parse(c.InAppParams) : c.InAppParams) : null,
            isAllOrganizations: c.IsAllOrganizations,
            targetOrganizationIds: c.TargetOrganizationIds
                ? (typeof c.TargetOrganizationIds === "string" ? JSON.parse(c.TargetOrganizationIds) : c.TargetOrganizationIds)
                : [],
            notificationCategory: c.NotificationCategory,
            status: c.Status,
            isActive: c.IsActive,
            totalSentCount: c.TotalSentCount || 0,
            lastSentAt: c.LastSentAt ? c.LastSentAt.toISOString() : null,
            createdAt: c.CreatedAt ? c.CreatedAt.toISOString() : null,
            updatedAt: c.UpdatedAt ? c.UpdatedAt.toISOString() : null,
        };
    }

    async getCampaigns(filter?: {
        scheduleType?: string;
        isActive?: boolean;
        category?: string;
        status?: string;
    }): Promise<any[]> {
        const campaigns = await pushCampaignRepository.findAll(filter);
        return campaigns.map(c => this.formatCampaign(c));
    }

    async getCampaignById(id: number): Promise<any | null> {
        const campaign = await pushCampaignRepository.findById(id);
        return campaign ? this.formatCampaign(campaign) : null;
    }

    async createCampaign(data: {
        title: string;
        body: string;
        imageUrl?: string | null;
        scheduleType?: string; // 'now' | 'scheduled' | 'recurring'
        scheduledDate?: string | null; // YYYY-MM-DD
        scheduledTime?: string | null; // HH:mm
        recurringPattern?: string | null; // 'daily' | 'weekly' | 'weekdays' | 'weekends'
        recurringDays?: string | null;
        redirectionType?: string; // 'in_app' | 'browser'
        redirectionUrl?: string | null;
        inAppRoute?: string | null;
        inAppParams?: any;
        isAllOrganizations?: boolean;
        targetOrganizationIds?: number[] | string;
        notificationCategory?: string;
        isActive?: boolean;
        sendImmediately?: boolean;
    }): Promise<any> {
        if (!data.title?.trim() || !data.body?.trim()) {
            throw new Error("Title and Body are required for a push notification");
        }

        const isAllOrgs = data.isAllOrganizations !== undefined ? Boolean(data.isAllOrganizations) : true;
        let formattedTargetOrgs: string | undefined = undefined;

        if (!isAllOrgs && data.targetOrganizationIds) {
            if (Array.isArray(data.targetOrganizationIds)) {
                formattedTargetOrgs = JSON.stringify(data.targetOrganizationIds.map(Number));
            } else if (typeof data.targetOrganizationIds === "string") {
                try {
                    const parsed = JSON.parse(data.targetOrganizationIds);
                    formattedTargetOrgs = JSON.stringify(Array.isArray(parsed) ? parsed.map(Number) : [Number(parsed)]);
                } catch {
                    formattedTargetOrgs = JSON.stringify(
                        data.targetOrganizationIds.split(",").map(s => Number(s.trim())).filter(n => !isNaN(n))
                    );
                }
            }
        }

        const hasImage = Boolean(data.imageUrl && data.imageUrl.trim().length > 0);
        const scheduleType = (data.scheduleType || "now").toLowerCase();
        let scheduledTime = data.scheduledTime?.trim() || null;
        if (scheduleType === "now") {
            scheduledTime = this.getISTTime();
        }

        const campaignData: Partial<PushCampaign> = {
            Title: data.title.trim(),
            Body: data.body.trim(),
            ImageUrl: hasImage ? data.imageUrl?.trim() : null,
            HasImage: hasImage,
            ScheduleType: scheduleType,
            ScheduledDate: data.scheduledDate ? new Date(data.scheduledDate) : null,
            ScheduledTime: scheduledTime,
            RecurringPattern: data.recurringPattern?.trim() || null,
            RecurringDays: data.recurringDays?.trim() || null,
            RedirectionType: data.redirectionType?.toLowerCase() === "browser" ? "browser" : "in_app",
            RedirectionUrl: data.redirectionUrl?.trim() || null,
            InAppRoute: data.inAppRoute?.trim() || "/patientDashboard",
            InAppParams: data.inAppParams ? (typeof data.inAppParams === "string" ? data.inAppParams : JSON.stringify(data.inAppParams)) : null,
            IsAllOrganizations: isAllOrgs,
            TargetOrganizationIds: formattedTargetOrgs,
            NotificationCategory: (data.notificationCategory || "GENERAL").toUpperCase(),
            Status: scheduleType === "now" ? "SENT" : (scheduleType === "scheduled" ? "SCHEDULED" : "ACTIVE"),
            IsActive: data.isActive !== undefined ? Boolean(data.isActive) : true,
            TotalSentCount: 0,
            LastSentAt: null,
        };

        const created = await pushCampaignRepository.create(campaignData);

        // If send immediately or scheduleType is 'now', dispatch push right away
        if (scheduleType === "now" || data.sendImmediately) {
            try {
                await this.dispatchCampaign(created.Id);
            } catch (dispatchErr) {
                console.error("[PushCampaignService] Error auto-dispatching campaign:", dispatchErr);
            }
        }

        const refetched = await pushCampaignRepository.findById(created.Id);
        return this.formatCampaign(refetched || created);
    }

    async updateCampaign(id: number, data: Partial<any>): Promise<any | null> {
        const payload: Partial<PushCampaign> = {};

        if (data.title !== undefined) payload.Title = data.title.trim();
        if (data.body !== undefined) payload.Body = data.body.trim();
        if (data.imageUrl !== undefined) {
            const hasImage = Boolean(data.imageUrl && data.imageUrl.trim().length > 0);
            payload.ImageUrl = hasImage ? data.imageUrl.trim() : null;
            payload.HasImage = hasImage;
        }
        if (data.scheduleType !== undefined) payload.ScheduleType = data.scheduleType.toLowerCase();
        if (data.scheduledDate !== undefined) payload.ScheduledDate = data.scheduledDate ? new Date(data.scheduledDate) : null;
        if (data.scheduledTime !== undefined) {
            if (payload.ScheduleType === "now" || data.scheduleType === "now") {
                payload.ScheduledTime = data.scheduledTime?.trim() === "10:00" ? null : (data.scheduledTime?.trim() || null);
            } else {
                payload.ScheduledTime = data.scheduledTime?.trim() || null;
            }
        }
        if (data.recurringPattern !== undefined) payload.RecurringPattern = data.recurringPattern?.trim() || null;
        if (data.recurringDays !== undefined) payload.RecurringDays = data.recurringDays?.trim() || null;
        if (data.redirectionType !== undefined) payload.RedirectionType = data.redirectionType.toLowerCase() === "browser" ? "browser" : "in_app";
        if (data.redirectionUrl !== undefined) payload.RedirectionUrl = data.redirectionUrl?.trim() || null;
        if (data.inAppRoute !== undefined) payload.InAppRoute = data.inAppRoute?.trim() || "/patientDashboard";
        if (data.inAppParams !== undefined) payload.InAppParams = typeof data.inAppParams === "string" ? data.inAppParams : JSON.stringify(data.inAppParams);
        if (data.isAllOrganizations !== undefined) payload.IsAllOrganizations = Boolean(data.isAllOrganizations);
        if (data.targetOrganizationIds !== undefined) {
            payload.TargetOrganizationIds = Array.isArray(data.targetOrganizationIds)
                ? JSON.stringify(data.targetOrganizationIds.map(Number))
                : String(data.targetOrganizationIds);
        }
        if (data.notificationCategory !== undefined) payload.NotificationCategory = data.notificationCategory.toUpperCase();

        // Properly update Status when campaign is scheduled, recurring, or instant
        const effectiveScheduleType = (payload.ScheduleType || data.scheduleType || "").toLowerCase();
        if (data.status !== undefined) {
            payload.Status = data.status.toUpperCase();
        } else if (effectiveScheduleType === "scheduled" || (data.scheduledDate && data.scheduledTime)) {
            // Re-arm campaign into SCHEDULED state so background scheduler picks it up
            payload.Status = "SCHEDULED";
        } else if (effectiveScheduleType === "recurring") {
            payload.Status = "ACTIVE";
        } else if (effectiveScheduleType === "now" && (data.sendImmediately || data.sendImmediately === undefined)) {
            payload.Status = "SENT";
        }

        if (data.isActive !== undefined) payload.IsActive = Boolean(data.isActive);

        await pushCampaignRepository.update(id, payload);

        // If sendImmediately is true or instant send requested
        if (data.sendImmediately || (effectiveScheduleType === "now" && data.sendImmediately !== false)) {
            try {
                await this.dispatchCampaign(id);
            } catch (dispatchErr) {
                console.error("[PushCampaignService] Error auto-dispatching campaign on update:", dispatchErr);
            }
        }

        const refetched = await pushCampaignRepository.findById(id);
        return refetched ? this.formatCampaign(refetched) : null;
    }

    async toggleActive(id: number): Promise<any | null> {
        const campaign = await pushCampaignRepository.findById(id);
        if (!campaign) throw new Error("Campaign not found");

        const updated = await pushCampaignRepository.update(id, {
            IsActive: !campaign.IsActive,
            Status: !campaign.IsActive ? "ACTIVE" : "PAUSED",
        });
        return updated ? this.formatCampaign(updated) : null;
    }

    async deleteCampaign(id: number): Promise<boolean> {
        return pushCampaignRepository.delete(id);
    }

    /**
     * Dispatches the campaign's push notification to all matching active patient devices,
     * logs in AppNotification table for in-app history, and increments TotalSentCount.
     */
    async dispatchCampaign(id: number): Promise<{ success: boolean; message: string; count: number; totalTokens?: number }> {
        const campaign = await pushCampaignRepository.findById(id);
        if (!campaign) throw new Error("Push campaign not found");

        const { userDeviceRepository } = await import("../../MobileApi/v1/repositories/userdevice.repository.js");
        const { sendFcmPushToTokens } = await import("./firebase-admin.service.js");
        const { AppDataSource } = await import("../../config/database.js");
        const { AppNotification } = await import("../../models/Common/app-notification.model.js");

        let activeDevices: any[] = [];

        if (campaign.IsAllOrganizations) {
            activeDevices = await userDeviceRepository.findAllActiveDevices();
        } else {
            let targetOrgIds: number[] = [];
            if (campaign.TargetOrganizationIds) {
                try {
                    const parsed = JSON.parse(campaign.TargetOrganizationIds);
                    targetOrgIds = Array.isArray(parsed) ? parsed.map(Number) : [Number(parsed)];
                } catch {
                    targetOrgIds = [];
                }
            }

            if (targetOrgIds.length > 0) {
                const { PatientRegistration } = await import("../../models/Organizations/patient-registration.model.js");
                const regRepo = AppDataSource.getRepository(PatientRegistration);

                const patientRegs = await regRepo.createQueryBuilder("pr")
                    .select("DISTINCT pr.UserId", "UserId")
                    .where("pr.OrganizationId IN (:...orgIds)", { orgIds: targetOrgIds })
                    .andWhere("pr.UserId IS NOT NULL")
                    .getRawMany();

                const userIds = patientRegs.map(p => p.UserId).filter(Boolean);

                if (userIds.length > 0) {
                    const { UserDevice } = await import("../../models/Account/userdevice.model.js");
                    const deviceRepo = AppDataSource.getRepository(UserDevice);

                    activeDevices = await deviceRepo.createQueryBuilder("d")
                        .where("d.UserId IN (:...userIds)", { userIds })
                        .andWhere("d.IsActive = 1")
                        .andWhere("d.FCMToken IS NOT NULL")
                        .andWhere("d.FCMToken != ''")
                        .getMany();
                }
            }
        }

        const validTokens = Array.from(
            new Set(
                activeDevices
                    .map(d => d.FCMToken?.trim())
                    .filter((t): t is string => !!t && t.length > 15 && t !== "no_token_available")
            )
        );

        const isBrowser = campaign.RedirectionType === "browser";
        const route = isBrowser ? undefined : (campaign.InAppRoute || undefined);
        const externalUrl = isBrowser ? (campaign.RedirectionUrl || undefined) : undefined;
        const additionalData: Record<string, any> = {
            campaignId: String(campaign.Id),
            category: campaign.NotificationCategory,
            redirectionType: campaign.RedirectionType,
            url: externalUrl,
            redirectionUrl: externalUrl,
            route: route,
        };

        if (campaign.HasImage && campaign.ImageUrl) {
            additionalData.imageUrl = campaign.ImageUrl;
        }

        // 1. Dispatch Firebase Cloud Messaging push
        let fcmSuccess = 0;
        let fcmFailure = 0;
        if (validTokens.length > 0) {
            try {
                const res = await sendFcmPushToTokens(validTokens, {
                    title: campaign.Title,
                    body: campaign.Body,
                    imageUrl: campaign.HasImage && campaign.ImageUrl ? campaign.ImageUrl : undefined,
                    type: campaign.NotificationCategory || "BROADCAST",
                    route: route || undefined,
                    referenceId: String(campaign.Id),
                    additionalData,
                });
                fcmSuccess = res.successCount;
                fcmFailure = res.failureCount;
                console.log(`[PushCampaignService] Dispatched push notification for Campaign #${campaign.Id} "${campaign.Title}": ${res.successCount} delivered, ${res.failureCount} failed/skipped`);
            } catch (fcmErr) {
                console.error(`[PushCampaignService] FCM dispatch error for Campaign #${campaign.Id}:`, fcmErr);
            }
        }

        // 2. Persist in AppNotification table for users to see in their in-app Notification Center
        const targetUserIds = Array.from(new Set(activeDevices.map(d => d.UserId).filter(Boolean)));
        if (targetUserIds.length > 0) {
            const notifRepo = AppDataSource.getRepository(AppNotification);
            const notifs = targetUserIds.map(uid => {
                const n = new AppNotification();
                n.UserId = uid;
                n.Title = campaign.Title;
                n.Body = campaign.Body;
                n.Type = campaign.NotificationCategory || "BROADCAST";
                n.ReferenceId = String(campaign.Id);
                n.Route = isBrowser ? (campaign.RedirectionUrl || null) : (route || null);
                n.ImageUrl = (campaign.HasImage && campaign.ImageUrl) ? campaign.ImageUrl : (campaign.ImageUrl || null);
                n.IsRead = false;
                n.CreatedAt = new Date();
                return n;
            });

            try {
                // Save in batches of 100
                for (let i = 0; i < notifs.length; i += 100) {
                    await notifRepo.save(notifs.slice(i, i + 100));
                }
            } catch (saveErr) {
                console.error("[PushCampaignService] Error saving in-app notification records:", saveErr);
            }
        }

        // 3. Update campaign stats
        const newCount = (campaign.TotalSentCount || 0) + fcmSuccess;
        const newStatus = campaign.ScheduleType === "scheduled" ? "COMPLETED" : campaign.Status;
        const now = new Date();
        const istTime = this.getISTTime(now);

        await pushCampaignRepository.update(campaign.Id, {
            TotalSentCount: newCount,
            LastSentAt: now,
            ScheduledTime: campaign.ScheduleType === "now" ? istTime : campaign.ScheduledTime,
            Status: newStatus,
        });

        const statusMsg = fcmSuccess > 0
            ? `Push notification successfully delivered to ${fcmSuccess} active device(s)${fcmFailure > 0 ? ` (${fcmFailure} offline/unregistered)` : ''}!`
            : (validTokens.length === 0 ? "No active devices registered to receive notifications." : "Notice: Devices found, but FCM tokens are expired or simulated.");

        return {
            success: true,
            message: statusMsg,
            count: fcmSuccess,
            totalTokens: validTokens.length,
        };
    }

    /**
     * Automated background scheduler check (called every 60 seconds).
     * Checks scheduled date & time as well as recurring continuous schedules.
     */
    async checkAndProcessScheduledCampaigns(): Promise<number> {
        try {
            const campaigns = await pushCampaignRepository.getActiveScheduledAndRecurring();
            if (!campaigns || campaigns.length === 0) return 0;

            const now = new Date();
            // Get local time in Asia/Kolkata (IST)
            const dateStr = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // 'YYYY-MM-DD'
            const timeStr = now.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }); // 'HH:mm'
            const dayOfWeek = now.toLocaleDateString("en-US", { timeZone: "Asia/Kolkata", weekday: "narrow" }); // e.g. 'M', 'T', 'W'
            const dayNum = now.getDay(); // 0 = Sun, 1 = Mon ... 6 = Sat

            let processedCount = 0;

            for (const campaign of campaigns) {
                // 1. One-time Scheduled Notification Check
                if (campaign.ScheduleType === "scheduled") {
                    if (!campaign.ScheduledDate || !campaign.ScheduledTime) continue;

                    let campaignDateStr = "";
                    const rawDate = campaign.ScheduledDate as any;
                    if (typeof rawDate === "string") {
                        campaignDateStr = rawDate.trim().slice(0, 10);
                    } else if (rawDate instanceof Date) {
                        campaignDateStr = rawDate.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
                    } else {
                        campaignDateStr = new Date(rawDate).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
                    }

                    const campaignTimeStr = campaign.ScheduledTime.trim();

                    // Trigger if date matches and time matches current minute, or overdue
                    if (
                        (campaignDateStr < dateStr || (campaignDateStr === dateStr && campaignTimeStr <= timeStr)) &&
                        campaign.Status !== "COMPLETED" &&
                        campaign.Status !== "SENT"
                    ) {
                        console.log(`[PushScheduler] Executing scheduled campaign #${campaign.Id}: "${campaign.Title}"`);
                        await this.dispatchCampaign(campaign.Id);
                        processedCount++;
                    }
                }

                // 2. Continuous / Recurring Notification Check
                else if (campaign.ScheduleType === "recurring") {
                    if (!campaign.ScheduledTime) continue;
                    const targetTime = campaign.ScheduledTime.trim();

                    // Only trigger during the exact minute
                    if (targetTime !== timeStr) continue;

                    // Prevent multiple executions in the same day
                    if (campaign.LastSentAt) {
                        const lastSentDateStr = new Date(campaign.LastSentAt).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
                        if (lastSentDateStr === dateStr) {
                            continue; // Already dispatched today
                        }
                    }

                    // Check pattern match
                    const pattern = (campaign.RecurringPattern || "daily").toLowerCase();
                    let shouldRun = false;

                    if (pattern === "daily") {
                        shouldRun = true;
                    } else if (pattern === "weekdays") {
                        shouldRun = dayNum >= 1 && dayNum <= 5;
                    } else if (pattern === "weekends") {
                        shouldRun = dayNum === 0 || dayNum === 6;
                    } else if (pattern === "weekly") {
                        const days = (campaign.RecurringDays || "").split(",").map(s => Number(s.trim()));
                        shouldRun = days.length === 0 || days.includes(dayNum);
                    }

                    if (shouldRun) {
                        console.log(`[PushScheduler] Executing recurring campaign #${campaign.Id} (${pattern} at ${timeStr}): "${campaign.Title}"`);
                        await this.dispatchCampaign(campaign.Id);
                        processedCount++;
                    }
                }
            }

            return processedCount;
        } catch (err: any) {
            console.error("[PushScheduler] Error checking scheduled campaigns:", err.message || err);
            return 0;
        }
    }

    /**
     * Starts the automated background cron scheduler (default: checks every 60 seconds)
     */
    startScheduler(intervalSeconds: number = 60) {
        if (this.schedulerInterval) {
            clearInterval(this.schedulerInterval);
        }

        console.log(`[PushScheduler] Push notification scheduler started (checking every ${intervalSeconds}s)`);
        this.schedulerInterval = setInterval(() => {
            this.checkAndProcessScheduledCampaigns();
        }, intervalSeconds * 1000);
    }

    stopScheduler() {
        if (this.schedulerInterval) {
            clearInterval(this.schedulerInterval);
            this.schedulerInterval = null;
            console.log("[PushScheduler] Push notification scheduler stopped.");
        }
    }
}

export const pushCampaignService = new PushCampaignService();
