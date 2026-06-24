import type { Request, Response } from "express";
import { patientDashboardService } from "../../services/Appointments/patient-dashboard.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class PatientDashboardController {
    async getDashboardDetails(req: Request, res: Response): Promise<void> {
        try {
            // Get userId from query param, path param or authenticated user token
            const userId = (req.query.userId || req.params.userId || req.query.patientId || (req as any).user?.Id) as string;

            if (!userId) {
                res.status(400).json(ApiResponse.error("User ID is required"));
                return;
            }

            const data = await patientDashboardService.getPatientDashboardDetails(userId);

            if (!data) {
                res.status(404).json(ApiResponse.error("Patient not found"));
                return;
            }

            res.status(200).json(ApiResponse.success(data, "Patient dashboard details retrieved successfully"));
        } catch (error) {
            console.error("Error fetching patient dashboard details:", error);
            res.status(500).json(ApiResponse.error(error instanceof Error ? error.message : "Failed to retrieve patient dashboard details"));
        }
    }
}

export const patientDashboardController = new PatientDashboardController();
