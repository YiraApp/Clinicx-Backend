import type { Request, Response } from "express";
import { hospitalSettingsService } from "../../services/Organizations/hospital-settings.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class HospitalSettingsController {
    /**
     * GET /hospitals/:hospitalId/settings
     */
    async getSettings(req: Request, res: Response) {
        try {
            const hospitalId = Number(req.params.hospitalId);
            if (!hospitalId || isNaN(hospitalId)) {
                return res.status(400).json(ApiResponse.error("Valid hospitalId parameter is required."));
            }

            const settings = await hospitalSettingsService.getSettings(hospitalId);
            return res.json(ApiResponse.success(settings, "Hospital settings retrieved successfully."));
        } catch (error: any) {
            console.error("Error retrieving hospital settings:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to retrieve hospital settings."));
        }
    }

    /**
     * PUT /hospitals/:hospitalId/settings
     */
    async saveSettings(req: Request, res: Response) {
        try {
            const hospitalId = Number(req.params.hospitalId);
            if (!hospitalId || isNaN(hospitalId)) {
                return res.status(400).json(ApiResponse.error("Valid hospitalId parameter is required."));
            }

            const userContext = {
                userId: (req as any).user?.Id || (req as any).user?.id || req.body?.userId || null,
                userName: (req as any).user?.Name || (req as any).user?.name || req.body?.userName || "Admin",
                roleName: (req as any).user?.RoleName || (req as any).user?.role || req.body?.roleName || "Hospital Admin",
                ipAddress: req.ip || req.headers["x-forwarded-for"] || null
            };

            const updated = await hospitalSettingsService.saveSettings(hospitalId, req.body, userContext);
            return res.json(ApiResponse.success(updated, "Hospital settings and audit history saved successfully."));
        } catch (error: any) {
            console.error("Error updating hospital settings:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to save hospital settings."));
        }
    }

    /**
     * GET /hospitals/:hospitalId/settings/history
     */
    async getHistory(req: Request, res: Response) {
        try {
            const hospitalId = Number(req.params.hospitalId);
            if (!hospitalId || isNaN(hospitalId)) {
                return res.status(400).json(ApiResponse.error("Valid hospitalId parameter is required."));
            }

            const limit = req.query.limit ? Number(req.query.limit) : 50;
            const history = await hospitalSettingsService.getSettingsHistory(hospitalId, limit);
            return res.json(ApiResponse.success(history, "Hospital settings change history retrieved successfully."));
        } catch (error: any) {
            console.error("Error retrieving hospital settings history:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to retrieve settings history."));
        }
    }

    /**
     * POST /hospitals/:hospitalId/settings/generate-slots
     */
    async triggerSlotGeneration(req: Request, res: Response) {
        try {
            const hospitalId = Number(req.params.hospitalId);
            if (!hospitalId || isNaN(hospitalId)) {
                return res.status(400).json(ApiResponse.error("Valid hospitalId parameter is required."));
            }

            const result = await hospitalSettingsService.triggerSlotGeneration(hospitalId);
            return res.json(ApiResponse.success(result, `Successfully generated ${result.totalSlotsGenerated} slots across ${result.doctorsProcessed} doctors.`));
        } catch (error: any) {
            console.error("Error running slot generation:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to execute slot generation."));
        }
    }
}

export const hospitalSettingsController = new HospitalSettingsController();
