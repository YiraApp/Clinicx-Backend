import type { Request, Response } from "express";
import { DashboardService } from "../../services/Common/dashboard.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

const dashboardService = new DashboardService();

export class DashboardController {
    async getAdminDashboardData(req: Request, res: Response): Promise<void> {
        try {
            const orgId = req.query.orgId ? parseInt(req.query.orgId as string) : undefined;
            const data = await dashboardService.getAdminDashboardData(orgId);
            res.status(200).json(ApiResponse.success(data, "Admin dashboard data retrieved successfully"));
        } catch (error) {
            console.error("Error fetching admin dashboard data:", error);
            res.status(500).json(ApiResponse.error(error instanceof Error ? error.message : "Failed to retrieve admin dashboard data"));
        }
    }

    async getSummary(req: Request, res: Response): Promise<void> {
        try {
            res.status(200).json(ApiResponse.success(null, "Summary retrieved successfully"));
        } catch (error) {
            res.status(500).json(ApiResponse.error("Failed to retrieve summary"));
        }
    }
}

export const dashboardController = new DashboardController();
