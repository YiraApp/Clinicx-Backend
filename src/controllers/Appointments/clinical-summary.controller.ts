import { Request, Response } from "express";
import { clinicalSummaryService } from "../../services/Appointments/clinical-summary.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class ClinicalSummaryController {
    async getSummary(req: Request, res: Response) {
        try {
            const appointmentId = parseInt(req.params.appointmentId as string);
            if (isNaN(appointmentId)) {
                return res.status(400).json(ApiResponse.error("Invalid Appointment ID."));
            }

            const result = await clinicalSummaryService.getSummary(appointmentId);
            return res.json(ApiResponse.success(result));
        } catch (error: any) {
            console.error("Error in ClinicalSummaryController:", error);
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }
}

export const clinicalSummaryController = new ClinicalSummaryController();
