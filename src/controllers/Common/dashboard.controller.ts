import type { Request, Response } from "express";
import { dashboardService } from "../../services/Common/dashboard.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class DashboardController {
    async getAdminDashboardData(req: Request, res: Response): Promise<void> {
        try {
            const orgId = req.query.orgId ? parseInt(req.query.orgId as string) : undefined;
            const hospId = req.query.hospId ? parseInt(req.query.hospId as string) : undefined;
            const data = await dashboardService.getAdminDashboardData(orgId, hospId);
            res.status(200).json(ApiResponse.success(data, "Admin dashboard data retrieved successfully"));
        } catch (error) {
            console.error("Error fetching admin dashboard data:", error);
            res.status(500).json(ApiResponse.error(error instanceof Error ? error.message : "Failed to retrieve admin dashboard data"));
        }
    }

    async getAnalytics(req: Request, res: Response): Promise<void> {
        try {
            const timeRange = req.query.timeRange as string || '30d';
            const data = await dashboardService.getAnalyticsData(timeRange);
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

    async getFrontdeskDashboardData(req: Request, res: Response): Promise<void> {
        try {
            const hospId = req.query.hospId ? parseInt(req.query.hospId as string) : undefined;
            if (!hospId) {
                res.status(400).json(ApiResponse.error("Hospital ID is required"));
                return;
            }
            const data = await dashboardService.getFrontdeskDashboardData(hospId);
            res.status(200).json(ApiResponse.success(data, "Frontdesk dashboard data retrieved successfully"));
        } catch (error) {
            console.error("Error fetching frontdesk dashboard data:", error);
            res.status(500).json(ApiResponse.error(error instanceof Error ? error.message : "Failed to retrieve frontdesk dashboard data"));
        }
    }

    async getDoctorDashboardData(req: Request, res: Response): Promise<void> {
        try {
            const doctorId = req.query.doctorId as string;
            const hospId = req.query.hospId ? parseInt(req.query.hospId as string) : undefined;
            if (!doctorId || !hospId) {
                res.status(400).json(ApiResponse.error("Doctor ID and Hospital ID are required"));
                return;
            }
            const data = await dashboardService.getDoctorDashboardData(doctorId, hospId);
            res.status(200).json(ApiResponse.success(data, "Doctor dashboard data retrieved successfully"));
        } catch (error) {
            console.error("Error fetching doctor dashboard data:", error);
            res.status(500).json(ApiResponse.error(error instanceof Error ? error.message : "Failed to retrieve doctor dashboard data"));
        }
    }
}

export const dashboardController = new DashboardController();
