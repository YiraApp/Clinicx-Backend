import type { Request, Response } from "express";
import { patientRegistrationService } from "../../services/Organizations/patient-registration.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class PatientRegistrationController {
    async register(req: Request, res: Response) {
        try {
            const result = await patientRegistrationService.registerPatient(req.body);
            return res.json(ApiResponse.success(result, "Patient registered successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async getPatients(req: Request, res: Response) {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const pageSize = parseInt(req.query.pageSize as string) || 10;
            const organizationId = req.headers["x-org-id"] ? parseInt(req.headers["x-org-id"] as string) : undefined;
            const hospitalId = req.query.hospitalId ? parseInt(req.query.hospitalId as string) : undefined;
            const search = req.query.search as string | undefined;

            const result = await patientRegistrationService.getPatients(page, pageSize, {
                organizationId,
                hospitalId,
                search,
            });
            return res.json(ApiResponse.success(result, "Patients fetched successfully."));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async sendRegistrationLink(req: Request, res: Response) {
        try {
            const orgId = req.headers["x-org-id"] ? parseInt(req.headers["x-org-id"] as string) : undefined;
            const hospitalId = req.query.hospitalId ? parseInt(req.query.hospitalId as string) : undefined;
            
            const result = await patientRegistrationService.sendRegistrationLink({
                ...req.body,
                organizationId: orgId,
                hospitalId: hospitalId,
            });
            return res.json(ApiResponse.success(result, "Registration link sent successfully."));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const patientRegistrationController = new PatientRegistrationController();
