import type { Request, Response } from "express";
import { offerBannerService } from "../../../services/Offers/offer-banner.service.js";
import { ApiResponse } from "../../../utils/response.utils.js";

/**
 * Retrieves active offer banners for the patient app.
 * Query param: organizationId (optional), placement (optional: 'carousel' | 'popup' | 'all')
 */
export const getActiveOffers = async (req: Request, res: Response) => {
    try {
        const orgIdParam = req.query.organizationId || (req as any).user?.OrganizationId;
        const organizationId = orgIdParam !== undefined && orgIdParam !== null ? Number(orgIdParam) : undefined;
        const placement = (req.query.placement as string)?.toLowerCase() || "carousel";

        const banners = await offerBannerService.getActiveOffers(
            !isNaN(Number(organizationId)) ? Number(organizationId) : undefined,
            placement
        );

        return res.json(ApiResponse.success(banners, "Active offer banners retrieved successfully"));
    } catch (error: any) {
        console.error("[OFFERS] Error fetching active offers:", error);
        return res.status(500).json(ApiResponse.error(error?.message || "Failed to retrieve offer banners"));
    }
};

/**
 * Retrieves the active popup ad for the patient app (if any).
 * Query param: organizationId (optional)
 */
export const getActivePopupAd = async (req: Request, res: Response) => {
    try {
        const orgIdParam = req.query.organizationId || (req as any).user?.OrganizationId;
        const organizationId = orgIdParam !== undefined && orgIdParam !== null ? Number(orgIdParam) : undefined;

        const popupAd = await offerBannerService.getActivePopupAd(
            !isNaN(Number(organizationId)) ? Number(organizationId) : undefined
        );

        return res.json(ApiResponse.success(popupAd, "Active popup ad retrieved successfully"));
    } catch (error: any) {
        console.error("[OFFERS] Error fetching active popup ad:", error);
        return res.status(500).json(ApiResponse.error(error?.message || "Failed to retrieve popup ad"));
    }
};
