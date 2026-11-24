import type { Request, Response } from "express";
import { ApiResponse } from "../../utils/response.utils.js";
import { ceoDashboardService } from "../../services/Common/ceo-dashboard.service.js";
import { FilterError, parseCeoDashboardQuery } from "../../services/Common/ceo-dashboard.filters.js";

/** CEO dashboard for Yira System Admin; the router lets no other role in. */
class CeoDashboardController {
    async getFilterOptions(_req: Request, res: Response): Promise<void> {
        try {
            const data = await ceoDashboardService.getFilterOptions();
            res.status(200).json(ApiResponse.success(data, "Dashboard filters retrieved"));
        } catch (error) {
            console.error("[CEO dashboard] Filters failed:", error);
            res.status(500).json(ApiResponse.error("The dashboard filters could not be loaded."));
        }
    }

    async getSummary(req: Request, res: Response): Promise<void> {
        let filters;
        try {
            filters = parseCeoDashboardQuery(req.query as Record<string, unknown>);
        } catch (error) {
            if (error instanceof FilterError) {
                res.status(400).json(ApiResponse.error(error.message));
                return;
            }
            throw error;
        }
        try {
            const data = await ceoDashboardService.getSummary(filters);
            res.status(200).json(ApiResponse.success(data, "Dashboard retrieved"));
        } catch (error) {
            console.error("[CEO dashboard] Summary failed:", error);
            res.status(500).json(ApiResponse.error("The dashboard could not be loaded."));
        }
    }
}

export const ceoDashboardController = new CeoDashboardController();
