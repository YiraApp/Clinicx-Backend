import type { Request, Response } from "express";
import { dashboardService } from "../../services/Common/dashboard.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

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

    async getAnalytics(req: Request, res: Response): Promise<void> {
        try {
            const data = await dashboardService.getAnalyticsData();
            res.status(200).json(ApiResponse.success(data, "Analytics data retrieved successfully"));
        } catch (error) {
            console.error("Error fetching analytics data:", error);
            res.status(500).json(ApiResponse.error(error instanceof Error ? error.message : "Failed to retrieve analytics data"));
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
