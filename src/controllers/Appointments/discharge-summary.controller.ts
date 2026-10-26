import { Request, Response } from "express";
import { dischargeSummaryService } from "../../services/Appointments/discharge-summary.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

const userId = (req: Request): string | undefined => (req as any).userId ? String((req as any).userId) : undefined;
const optionalInt = (value: unknown): number | undefined => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : undefined;
};

export class DischargeSummaryController {
    async create(req: Request, res: Response) {
        try {
            const result = await dischargeSummaryService.create(req.body, userId(req));
            return res.status(201).json(ApiResponse.success(result, "Discharge summary saved."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async get(req: Request, res: Response) {
        try {
            const result = await dischargeSummaryService.get(Number(req.params.id));
            if (!result) return res.status(404).json(ApiResponse.error("Discharge summary not found."));
            return res.json(ApiResponse.success(result));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async listForPatient(req: Request, res: Response) {
        try {
            const result = await dischargeSummaryService.listForPatient(String(req.params.patientId), optionalInt(req.query.hospitalId));
            return res.json(ApiResponse.success(result));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async update(req: Request, res: Response) {
        try {
            const result = await dischargeSummaryService.update(Number(req.params.id), req.body, userId(req));
            return res.json(ApiResponse.success(result, "Discharge summary updated."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async delete(req: Request, res: Response) {
        try {
            await dischargeSummaryService.delete(Number(req.params.id), userId(req));
            return res.json(ApiResponse.success(null, "Discharge summary deleted."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }
}

export const dischargeSummaryController = new DischargeSummaryController();
