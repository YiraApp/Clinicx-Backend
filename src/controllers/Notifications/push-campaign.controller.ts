import type { Request, Response } from "express";
import { pushCampaignService } from "../../services/Notifications/push-campaign.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class PushCampaignController {
    async getAll(req: Request, res: Response) {
        try {
            const scheduleType = req.query.scheduleType as string | undefined;
            const category = req.query.category as string | undefined;
            const status = req.query.status as string | undefined;
            const isActiveParam = req.query.isActive as string | undefined;

            const isActive = isActiveParam !== undefined && isActiveParam !== ""
                ? isActiveParam === "true" || isActiveParam === "1"
                : undefined;

            const campaigns = await pushCampaignService.getCampaigns({
                scheduleType,
                category,
                status,
                isActive,
            });

            return res.json(ApiResponse.success(campaigns, "Push campaigns retrieved successfully"));
        } catch (error: any) {
            console.error("[PUSH_CAMPAIGN] Error retrieving campaigns:", error);
            return res.status(500).json(ApiResponse.error(error?.message || "Failed to retrieve push campaigns"));
        }
    }

    async getById(req: Request, res: Response) {
        try {
            const id = Number(req.params.id);
            if (isNaN(id)) return res.status(400).json(ApiResponse.error("Invalid campaign ID"));

            const campaign = await pushCampaignService.getCampaignById(id);
            if (!campaign) return res.status(404).json(ApiResponse.error("Push campaign not found"));

            return res.json(ApiResponse.success(campaign, "Push campaign retrieved successfully"));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error?.message || "Failed to retrieve campaign"));
        }
    }

    async create(req: Request, res: Response) {
        try {
            const campaign = await pushCampaignService.createCampaign(req.body);
            return res.status(201).json(ApiResponse.success(campaign, "Push campaign created successfully"));
        } catch (error: any) {
            console.error("[PUSH_CAMPAIGN] Error creating campaign:", error);
            return res.status(400).json(ApiResponse.error(error?.message || "Failed to create push campaign"));
        }
    }

    async update(req: Request, res: Response) {
        try {
            const id = Number(req.params.id);
            if (isNaN(id)) return res.status(400).json(ApiResponse.error("Invalid campaign ID"));

            const updated = await pushCampaignService.updateCampaign(id, req.body);
            if (!updated) return res.status(404).json(ApiResponse.error("Push campaign not found"));

            return res.json(ApiResponse.success(updated, "Push campaign updated successfully"));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error?.message || "Failed to update push campaign"));
        }
    }

    async toggleStatus(req: Request, res: Response) {
        try {
            const id = Number(req.params.id);
            if (isNaN(id)) return res.status(400).json(ApiResponse.error("Invalid campaign ID"));

            const updated = await pushCampaignService.toggleActive(id);
            return res.json(ApiResponse.success(updated, "Campaign active status updated"));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error?.message || "Failed to toggle status"));
        }
    }

    async delete(req: Request, res: Response) {
        try {
            const id = Number(req.params.id);
            if (isNaN(id)) return res.status(400).json(ApiResponse.error("Invalid campaign ID"));

            const success = await pushCampaignService.deleteCampaign(id);
            return res.json(ApiResponse.success({ success }, "Push campaign deleted"));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error?.message || "Failed to delete campaign"));
        }
    }

    async sendPush(req: Request, res: Response) {
        try {
            const id = Number(req.params.id);
            if (isNaN(id)) return res.status(400).json(ApiResponse.error("Invalid campaign ID"));

            const result = await pushCampaignService.dispatchCampaign(id);
            return res.json(ApiResponse.success(result, result.message));
        } catch (error: any) {
            console.error("[PUSH_CAMPAIGN] Error dispatching push:", error);
            return res.status(500).json(ApiResponse.error(error?.message || "Failed to send push notification"));
        }
    }
}

export const pushCampaignController = new PushCampaignController();
