import { Request, Response } from "express";
import { patientFitnessService } from "../services/patient-fitness.service.js";
import { ApiResponse } from "../../../utils/response.utils.js";

export class PatientFitnessController {
    /**
     * Batch upsert fitness records from device (Apple Health / Google Health Connect)
     * POST /v1/api/auth/patient/fitness/sync
     */
    async syncFitness(req: Request, res: Response): Promise<Response> {
        try {
            const patientId = req.body.patientId || (req as any).user?.userId;
            const source = req.body.source || "Unknown";
            const records = req.body.records || [];

            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required"));
            }

            const result = await patientFitnessService.syncFitnessBatch(patientId, source, records);
            return res.status(200).json(ApiResponse.success(result, "Fitness records synced successfully"));
        } catch (error: any) {
            console.error("❌ Error syncing fitness data:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to sync fitness data"));
        }
    }

    /**
     * Get historical fitness summary and chart trends
     * GET /v1/api/auth/patient/fitness/summary?patientId=...&period=day|week|month
     */
    async getFitnessSummary(req: Request, res: Response): Promise<Response> {
        try {
            const patientId = (req.query.patientId as string) || (req as any).user?.userId;
            const period = ((req.query.period as string) || "week") as "day" | "week" | "month";

            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required"));
            }

            const summary = await patientFitnessService.getFitnessSummary(patientId, period);
            return res.status(200).json(ApiResponse.success(summary, "Fitness summary retrieved"));
        } catch (error: any) {
            console.error("❌ Error retrieving fitness summary:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to retrieve fitness summary"));
        }
    }

    /**
     * Get fitness connection status and latest sync information
     * GET /v1/api/auth/patient/fitness/status?patientId=...
     */
    async getFitnessStatus(req: Request, res: Response): Promise<Response> {
        try {
            const patientId = (req.query.patientId as string) || (req as any).user?.userId;

            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required"));
            }

            const status = await patientFitnessService.getFitnessStatus(patientId);
            return res.status(200).json(ApiResponse.success(status, "Fitness status retrieved"));
        } catch (error: any) {
            console.error("❌ Error retrieving fitness status:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to retrieve fitness status"));
        }
    }

    /**
     * Disconnect fitness integration
     * POST /v1/api/auth/patient/fitness/disconnect
     */
    async disconnectFitness(req: Request, res: Response): Promise<Response> {
        try {
            const patientId = req.body.patientId || (req as any).user?.userId;

            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required"));
            }

            return res.status(200).json(ApiResponse.success({ disconnected: true }, "Fitness disconnected successfully"));
        } catch (error: any) {
            console.error("❌ Error disconnecting fitness:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to disconnect fitness"));
        }
    }
}

export const patientFitnessController = new PatientFitnessController();
