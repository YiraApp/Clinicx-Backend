import type { Request, Response } from "express";
import { hospitalRegistryService } from "../../services/Organizations/hospital-registry.service.js";

export class HospitalRegistryController {
    async getRegistry(req: Request, res: Response) {
        try {
            const hospitalId = parseInt(String(req.params.hospitalId));
            const data = await hospitalRegistryService.getHospitalRegistry(hospitalId);
            res.json({ status: true, data });
        } catch (error: any) {
            res.status(500).json({ status: false, message: error.message });
        }
    }

    async updateRegistry(req: Request, res: Response) {
        try {
            const hospitalId = parseInt(String(req.params.hospitalId));
            const { specialties, subSpecialties, departments } = req.body;
            const data = await hospitalRegistryService.updateHospitalRegistry(hospitalId, {
                specialties: specialties || [],
                subSpecialties: subSpecialties || [],
                departments: departments || []
            });
            res.json({ status: true, message: "Registry updated successfully", data });
        } catch (error: any) {
            res.status(500).json({ status: false, message: error.message });
        }
    }
}

export const hospitalRegistryController = new HospitalRegistryController();
