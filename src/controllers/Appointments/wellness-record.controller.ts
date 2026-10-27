import { Request, Response } from "express";
import { wellnessRecordService } from "../../services/Appointments/wellness-record.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

const userId = (req: Request): string | undefined => (req as any).userId ? String((req as any).userId) : undefined;
const optionalInt = (value: unknown): number | undefined => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : undefined;
};

export class WellnessRecordController {
    async create(req: Request, res: Response) {
        try {
            const result = await wellnessRecordService.create(req.body, userId(req));
            return res.status(201).json(ApiResponse.success(result, "Wellness record saved."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async listForPatient(req: Request, res: Response) {
        try {
            const result = await wellnessRecordService.listForPatient(String(req.params.patientId), optionalInt(req.query.hospitalId));
            return res.json(ApiResponse.success(result));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async update(req: Request, res: Response) {
        try {
            const result = await wellnessRecordService.update(Number(req.params.id), req.body, userId(req));
            return res.json(ApiResponse.success(result, "Wellness record updated."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async delete(req: Request, res: Response) {
        try {
            await wellnessRecordService.delete(Number(req.params.id), userId(req));
            return res.json(ApiResponse.success(null, "Wellness record deleted."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }
}

export const wellnessRecordController = new WellnessRecordController();
