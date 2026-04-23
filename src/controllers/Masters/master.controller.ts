import type { Request, Response } from "express";
import { masterService } from "../../services/Masters/master.service.js";

export class MasterController {
    async getSpecialties(req: Request, res: Response) {
        try {
            const data = await masterService.getAllSpecialties();
            res.json({ status: true, data });
        } catch (error: any) {
            res.status(500).json({ status: false, message: error.message });
        }
    }

    async getSubSpecialties(req: Request, res: Response) {
        try {
            const specialtyId = req.query.specialtyId ? parseInt(req.query.specialtyId as string) : undefined;
            const data = await masterService.getAllSubSpecialties(specialtyId);
            res.json({ status: true, data });
        } catch (error: any) {
            res.status(500).json({ status: false, message: error.message });
        }
    }

    async getDepartments(req: Request, res: Response) {
        try {
            const data = await masterService.getAllDepartments();
            res.json({ status: true, data });
        } catch (error: any) {
            res.status(500).json({ status: false, message: error.message });
        }
    }
}

export const masterController = new MasterController();
