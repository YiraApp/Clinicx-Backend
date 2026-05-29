import type { Request, Response } from "express";
import { patientSummaryService } from "../../services/Appointments/patient-summary.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class PatientSummaryController {
    async getSummary(req: Request, res: Response): Promise<void> {
        try {
            const patientId = req.query.patientId as string;
            const orgId = req.query.orgId ? parseInt(req.query.orgId as string) : undefined;
            const hospitalId = req.query.hospitalId ? parseInt(req.query.hospitalId as string) : undefined;

            if (!patientId) {
                res.status(400).json(ApiResponse.error("Patient ID is required"));
                return;
            }

            const data = await patientSummaryService.getPatientSummary(patientId, orgId, hospitalId);

            if (!data) {
                res.status(404).json(ApiResponse.error("Patient not found"));
                return;
            }

            res.status(200).json(ApiResponse.success(data, "Patient summary retrieved successfully"));
        } catch (error) {
            console.error("Error fetching patient summary:", error);
            res.status(500).json(ApiResponse.error(error instanceof Error ? error.message : "Failed to retrieve patient summary"));
        }
    }
}

export const patientSummaryController = new PatientSummaryController();
