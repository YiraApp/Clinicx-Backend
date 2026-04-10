import type { Request, Response } from "express";
import { dashboardService } from "../../services/Common/dashboard.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

/**
 * Controller for Dashboard-related operations.
 */
export class DashboardController {
    /**
     * Handles fetching dashboard summary metrics.
     */
    async getSummary(req: Request, res: Response) {
        try {
            const result = await dashboardService.getDashboardSummary();
            return res.json(ApiResponse.success(result, "Dashboard summary fetched successfully."));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const dashboardController = new DashboardController();
