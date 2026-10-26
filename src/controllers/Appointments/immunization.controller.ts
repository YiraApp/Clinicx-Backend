import { Request, Response } from "express";
import { immunizationService } from "../../services/Appointments/immunization.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

const userId = (req: Request): string | undefined => (req as any).userId ? String((req as any).userId) : undefined;
const optionalInt = (value: unknown): number | undefined => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : undefined;
};

export class ImmunizationController {
    async create(req: Request, res: Response) {
        try {
            const result = await immunizationService.create(req.body, userId(req));
            return res.status(201).json(ApiResponse.success(result, "Immunization recorded."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async listForPatient(req: Request, res: Response) {
        try {
            const result = await immunizationService.listForPatient(String(req.params.patientId), optionalInt(req.query.hospitalId));
            return res.json(ApiResponse.success(result));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async update(req: Request, res: Response) {
        try {
            const result = await immunizationService.update(Number(req.params.id), req.body, userId(req));
            return res.json(ApiResponse.success(result, "Immunization updated."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async delete(req: Request, res: Response) {
        try {
            await immunizationService.delete(Number(req.params.id), userId(req));
            return res.json(ApiResponse.success(null, "Immunization deleted."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }
}

export const immunizationController = new ImmunizationController();
