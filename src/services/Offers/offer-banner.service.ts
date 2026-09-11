import { offerBannerRepository } from "../../repositories/Offers/offer-banner.repository.js";
import { OfferBanner } from "../../models/Offers/offer-banner.model.js";

export class OfferBannerService {
    async getActiveOffers(organizationId?: number, placement: string = "carousel"): Promise<any[]> {
        const banners = await offerBannerRepository.getActiveOffers(organizationId, placement);
        return banners.map(b => this.formatBanner(b));
    }

    async getActivePopupAd(organizationId?: number): Promise<any | null> {
        const ads = await offerBannerRepository.getActiveOffers(organizationId, "popup");
        return ads.length > 0 ? this.formatBanner(ads[0]) : null;
    }

    async getAllOffers(options?: { organizationId?: number; isActive?: boolean; placement?: string }): Promise<any[]> {
        const banners = await offerBannerRepository.findAll(options);
        return banners.map(b => this.formatBanner(b));
    }

    async getOfferById(id: number): Promise<any | null> {
        const banner = await offerBannerRepository.findById(id);
        return banner ? this.formatBanner(banner) : null;
    }

    async createOffer(data: {
        title?: string;
        description?: string;
        imageUrl: string;
        placement?: string; // 'carousel' | 'popup'
        redirectionType?: string; // 'browser' | 'in_app'
        redirectionUrl?: string;
        inAppRoute?: string;
        inAppParams?: any;
        isAllOrganizations?: boolean;
        targetOrganizationIds?: number[] | string;
        isActive?: boolean;
        showTitle?: boolean;
        showDescription?: boolean;
        showOfferTag?: boolean;
        offerTag?: string;
        displayOrder?: number;
        startDate?: Date | string;
        endDate?: Date | string;
        maxDisplayCount?: number;
        sendImmediately?: boolean;
    }): Promise<any> {
        if (!data.imageUrl || data.imageUrl.trim().length === 0) {
            throw new Error("Image URL is required for offer banner");
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

        const normPlacement = data.placement?.toLowerCase();
        const placement = normPlacement === "popup" ? "popup" : (normPlacement === "notification" ? "notification" : "carousel");

        const bannerData: Partial<OfferBanner> = {
            Title: data.title?.trim(),
            Description: data.description?.trim(),
            ImageUrl: data.imageUrl.trim(),
            Placement: placement,
            RedirectionType: data.redirectionType?.toLowerCase() === "in_app" ? "in_app" : "browser",
            RedirectionUrl: data.redirectionUrl?.trim(),
            InAppRoute: data.inAppRoute?.trim(),
            InAppParams: data.inAppParams ? (typeof data.inAppParams === "string" ? data.inAppParams : JSON.stringify(data.inAppParams)) : undefined,
            IsAllOrganizations: isAllOrgs,
            TargetOrganizationIds: formattedTargetOrgs,
            IsActive: data.isActive !== undefined ? Boolean(data.isActive) : true,
            ShowTitle: data.showTitle !== undefined ? Boolean(data.showTitle) : true,
            ShowDescription: data.showDescription !== undefined ? Boolean(data.showDescription) : true,
            ShowOfferTag: data.showOfferTag !== undefined ? Boolean(data.showOfferTag) : true,
            OfferTag: data.offerTag ? data.offerTag.trim() : "SPECIAL OFFER",
            DisplayOrder: data.displayOrder !== undefined ? Number(data.displayOrder) : 0,
            StartDate: data.startDate ? new Date(data.startDate) : undefined,
            EndDate: data.endDate ? new Date(data.endDate) : undefined,
            MaxDisplayCount: placement === "popup"
                ? (data.maxDisplayCount !== undefined ? Number(data.maxDisplayCount) : 0)
                : 0,
        };

        const created = await offerBannerRepository.create(bannerData);
        if (data.sendImmediately && placement === "notification") {
            try {
                await this.sendPushNotification(created.Id);
            } catch (pushErr) {
                console.error("Failed to automatically dispatch push notification on creation:", pushErr);
            }
        }
        return this.formatBanner(created);
    }

    async updateOffer(id: number, data: Partial<any>): Promise<any | null> {
        const updatePayload: Partial<OfferBanner> = {};

        if (data.title !== undefined) updatePayload.Title = data.title;
        if (data.description !== undefined) updatePayload.Description = data.description;
        if (data.imageUrl !== undefined) updatePayload.ImageUrl = data.imageUrl;
        if (data.placement !== undefined) {
            const norm = data.placement.toLowerCase();
            updatePayload.Placement = norm === "popup" ? "popup" : (norm === "notification" ? "notification" : "carousel");
            if (updatePayload.Placement !== "popup") {
                updatePayload.MaxDisplayCount = 0;
            }
        }
        if (data.redirectionType !== undefined) {
            updatePayload.RedirectionType = data.redirectionType.toLowerCase() === "in_app" ? "in_app" : "browser";
        }
        if (data.redirectionUrl !== undefined) updatePayload.RedirectionUrl = data.redirectionUrl;
        if (data.inAppRoute !== undefined) updatePayload.InAppRoute = data.inAppRoute;
        if (data.inAppParams !== undefined) {
            updatePayload.InAppParams = typeof data.inAppParams === "string" ? data.inAppParams : JSON.stringify(data.inAppParams);
        }
        if (data.isAllOrganizations !== undefined) updatePayload.IsAllOrganizations = Boolean(data.isAllOrganizations);
        if (data.targetOrganizationIds !== undefined) {
            if (Array.isArray(data.targetOrganizationIds)) {
                updatePayload.TargetOrganizationIds = JSON.stringify(data.targetOrganizationIds.map(Number));
            } else {
                updatePayload.TargetOrganizationIds = String(data.targetOrganizationIds);
            }
        }
        if (data.isActive !== undefined) updatePayload.IsActive = Boolean(data.isActive);
        if (data.showTitle !== undefined) updatePayload.ShowTitle = Boolean(data.showTitle);
        if (data.showDescription !== undefined) updatePayload.ShowDescription = Boolean(data.showDescription);
        if (data.showOfferTag !== undefined) updatePayload.ShowOfferTag = Boolean(data.showOfferTag);
        if (data.offerTag !== undefined) updatePayload.OfferTag = data.offerTag?.trim() || "";
        if (data.displayOrder !== undefined) updatePayload.DisplayOrder = Number(data.displayOrder);
        if (data.startDate !== undefined) updatePayload.StartDate = data.startDate ? new Date(data.startDate) : undefined;
        if (data.endDate !== undefined) updatePayload.EndDate = data.endDate ? new Date(data.endDate) : undefined;
        if (data.maxDisplayCount !== undefined && updatePayload.Placement !== "carousel") {
            updatePayload.MaxDisplayCount = Number(data.maxDisplayCount);
        }

        const updated = await offerBannerRepository.update(id, updatePayload);
        return updated ? this.formatBanner(updated) : null;
    }

    async sendPushNotification(id: number): Promise<{ success: boolean; message: string; count: number }> {
        const banner = await offerBannerRepository.findById(id);
        if (!banner) {
            throw new Error("Offer banner not found");
        }

        const title = banner.Title || "Special Offer • Yira Health";
        const body = banner.Description || banner.OfferTag || "Check out our latest health package offer!";
        const route = banner.RedirectionType === "in_app" ? banner.InAppRoute : undefined;

        const { userDeviceRepository } = await import("../../MobileApi/v1/repositories/userdevice.repository.js");
        const { sendFcmPushToTokens } = await import("../Notifications/firebase-admin.service.js");
        const { AppDataSource } = await import("../../config/database.js");
        const { AppNotification } = await import("../../models/Common/app-notification.model.js");

        let activeDevices: any[] = [];

        if (banner.IsAllOrganizations || !banner.TargetOrganizationIds) {
            activeDevices = await userDeviceRepository.findAllActiveDevices();
        } else {
            try {
                let targetOrgIds: number[] = [];
                try {
                    const parsed = JSON.parse(banner.TargetOrganizationIds);
                    targetOrgIds = Array.isArray(parsed) ? parsed.map(Number) : [Number(parsed)];
                } catch {
                    targetOrgIds = banner.TargetOrganizationIds.split(",").map(s => Number(s.trim())).filter(n => !isNaN(n));
                }

                const { PatientRegistration } = await import("../../models/Organizations/patient-registration.model.js");
                const regRepo = AppDataSource.getRepository(PatientRegistration);
                const regs = await regRepo.createQueryBuilder("r")
                    .where("r.OrganizationId IN (:...orgIds)", { orgIds: targetOrgIds })
                    .getMany();

                const userIds = Array.from(new Set(regs.map(r => r.UserId).filter(Boolean)));
                for (const uid of userIds) {
                    const devs = await userDeviceRepository.findActiveDevicesByUserId(uid);
                    activeDevices.push(...devs);
                }
            } catch (orgQueryErr) {
                console.error("[OFFERS] Error resolving target organization devices:", orgQueryErr);
                activeDevices = await userDeviceRepository.findAllActiveDevices();
            }
        }

        const validTokens = Array.from(
            new Set(
                activeDevices
                    .map(d => d.FCMToken?.trim())
                    .filter((t): t is string => !!t && t.length > 10 && t !== "no_token_available")
            )
        );

        console.log(`[OFFERS] Dispatching push notification for offer #${banner.Id} to ${validTokens.length} active device(s)`);

        let fcmSuccess = 0;
        let fcmFailure = 0;
        if (validTokens.length > 0) {
            const res = await sendFcmPushToTokens(validTokens, {
                title,
                body,
                imageUrl: banner.ImageUrl || undefined,
                type: "OFFER_PROMOTION",
                route: route || undefined,
                referenceId: String(banner.Id),
                additionalData: {
                    imageUrl: banner.ImageUrl,
                    redirectionType: banner.RedirectionType,
                    redirectionUrl: banner.RedirectionUrl || "",
                    inAppRoute: banner.InAppRoute || "",
                    offerId: String(banner.Id),
                }
            });
            fcmSuccess = res.successCount;
            fcmFailure = res.failureCount;
        }

        try {
            const notifRepo = AppDataSource.getRepository(AppNotification);
            const userIds = Array.from(new Set(activeDevices.map(d => d.UserId).filter(Boolean)));
            for (const uid of userIds) {
                const notif = new AppNotification();
                notif.UserId = uid;
                notif.Title = title;
                notif.Body = body;
                notif.Type = "OFFER_PROMOTION";
                notif.ReferenceId = String(banner.Id);
                notif.Route = route || null;
                notif.IsRead = false;
                notif.CreatedAt = new Date();
                await notifRepo.save(notif).catch(() => null);
            }
        } catch (err) {
            console.error("[OFFERS] Error saving in-app notification records:", err);
        }

        return {
            success: true,
            message: fcmSuccess > 0 
                ? `Push notification successfully dispatched to ${fcmSuccess} active mobile device(s)!`
                : (validTokens.length > 0
                    ? "Push notification recorded in notification center (devices were offline or tokens invalid)."
                    : "Push notification created and recorded (no active mobile devices currently online)."),
            count: fcmSuccess
        };
    }

    async toggleStatus(id: number): Promise<any | null> {
        const updated = await offerBannerRepository.toggleStatus(id);
        return updated ? this.formatBanner(updated) : null;
    }

    async deleteOffer(id: number): Promise<boolean> {
        return await offerBannerRepository.delete(id);
    }

    private formatBanner(banner: OfferBanner): any {
        let parsedOrgIds: number[] = [];
        if (banner.TargetOrganizationIds) {
            try {
                const parsed = JSON.parse(banner.TargetOrganizationIds);
                parsedOrgIds = Array.isArray(parsed) ? parsed.map(Number) : [];
            } catch {
                parsedOrgIds = banner.TargetOrganizationIds.split(",").map(s => Number(s.trim())).filter(n => !isNaN(n));
            }
        }

        let parsedParams: any = null;
        if (banner.InAppParams) {
            try {
                parsedParams = JSON.parse(banner.InAppParams);
            } catch {
                parsedParams = banner.InAppParams;
            }
        }

        return {
            id: banner.Id,
            title: banner.Title || "",
            description: banner.Description || "",
            imageUrl: banner.ImageUrl,
            placement: banner.Placement || "carousel",
            redirectionType: banner.RedirectionType || "browser",
            redirectionUrl: banner.RedirectionUrl || "",
            inAppRoute: banner.InAppRoute || "",
            inAppParams: parsedParams,
            isAllOrganizations: banner.IsAllOrganizations ?? true,
            targetOrganizationIds: parsedOrgIds,
            isActive: banner.IsActive ?? true,
            showTitle: banner.ShowTitle ?? true,
            showDescription: banner.ShowDescription ?? true,
            showOfferTag: banner.ShowOfferTag ?? true,
            offerTag: banner.OfferTag ?? "SPECIAL OFFER",
            displayOrder: banner.DisplayOrder || 0,
            startDate: banner.StartDate,
            endDate: banner.EndDate,
            maxDisplayCount: (banner.Placement?.toLowerCase() === "popup") ? (banner.MaxDisplayCount ?? 0) : 0,
            createdAt: banner.CreatedAt,
            updatedAt: banner.UpdatedAt,
        };
    }
}

export const offerBannerService = new OfferBannerService();
