import type { Request, Response } from "express";
import { offerBannerService } from "../../services/Offers/offer-banner.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class OfferBannerController {
    async getAll(req: Request, res: Response) {
        try {
            const orgIdParam = req.query.organizationId;
            const isActiveParam = req.query.isActive;
            const placementParam = req.query.placement as string | undefined;

            const organizationId = orgIdParam !== undefined && orgIdParam !== null && orgIdParam !== "" 
                ? Number(orgIdParam) 
                : undefined;
            const isActive = isActiveParam !== undefined && isActiveParam !== null && isActiveParam !== ""
                ? isActiveParam === "true" || isActiveParam === "1"
                : undefined;

            const banners = await offerBannerService.getAllOffers({
                organizationId: !isNaN(Number(organizationId)) ? Number(organizationId) : undefined,
                isActive,
                placement: placementParam
            });

            return res.json(ApiResponse.success(banners, "Offers retrieved successfully"));
        } catch (error: any) {
            console.error("[OFFERS] Error getting offers:", error);
            return res.status(500).json(ApiResponse.error(error?.message || "Failed to retrieve offers"));
        }
    }

    async getById(req: Request, res: Response) {
        try {
            const id = Number(req.params.id);
            if (isNaN(id)) {
                return res.status(400).json(ApiResponse.error("Invalid offer ID"));
            }

            const banner = await offerBannerService.getOfferById(id);
            if (!banner) {
                return res.status(404).json(ApiResponse.error("Offer banner not found"));
            }

            return res.json(ApiResponse.success(banner, "Offer banner retrieved successfully"));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error?.message || "Failed to retrieve offer"));
        }
    }

    async create(req: Request, res: Response) {
        try {
            const banner = await offerBannerService.createOffer(req.body);
            return res.status(201).json(ApiResponse.success(banner, "Offer banner created successfully"));
        } catch (error: any) {
            console.error("[OFFERS] Error creating offer:", error);
            return res.status(400).json(ApiResponse.error(error?.message || "Failed to create offer banner"));
        }
    }

    async update(req: Request, res: Response) {
        try {
            const id = Number(req.params.id);
            if (isNaN(id)) {
                return res.status(400).json(ApiResponse.error("Invalid offer ID"));
            }

            const updated = await offerBannerService.updateOffer(id, req.body);
            if (!updated) {
                return res.status(404).json(ApiResponse.error("Offer banner not found"));
            }

            return res.json(ApiResponse.success(updated, "Offer banner updated successfully"));
        } catch (error: any) {
            console.error("[OFFERS] Error updating offer:", error);
            return res.status(400).json(ApiResponse.error(error?.message || "Failed to update offer banner"));
        }
    }

    async toggleStatus(req: Request, res: Response) {
        try {
            const id = Number(req.params.id);
            if (isNaN(id)) {
                return res.status(400).json(ApiResponse.error("Invalid offer ID"));
            }

            const updated = await offerBannerService.toggleStatus(id);
            if (!updated) {
                return res.status(404).json(ApiResponse.error("Offer banner not found"));
            }

            return res.json(ApiResponse.success(updated, "Offer banner status toggled successfully"));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error?.message || "Failed to toggle status"));
        }
    }

    async delete(req: Request, res: Response) {
        try {
            const id = Number(req.params.id);
            if (isNaN(id)) {
                return res.status(400).json(ApiResponse.error("Invalid offer ID"));
            }

            const success = await offerBannerService.deleteOffer(id);
            if (!success) {
                return res.status(404).json(ApiResponse.error("Offer banner not found"));
            }

            return res.json(ApiResponse.success(null, "Offer banner deleted successfully"));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error?.message || "Failed to delete offer banner"));
        }
    }

    async sendPush(req: Request, res: Response) {
        try {
            const id = Number(req.params.id);
            if (isNaN(id)) {
                return res.status(400).json(ApiResponse.error("Invalid offer ID"));
            }

            const result = await offerBannerService.sendPushNotification(id);
            return res.json(ApiResponse.success(result, result.message));
        } catch (error: any) {
            console.error("[OFFERS] Error sending push notification:", error);
            return res.status(500).json(ApiResponse.error(error?.message || "Failed to send push notification"));
        }
    }
}

export const offerBannerController = new OfferBannerController();
