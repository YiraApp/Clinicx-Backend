import type { Request, Response } from "express";
import { patientRegistrationService } from "../../services/Organizations/patient-registration.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class PatientRegistrationController {

    async getNextToken(req: Request, res: Response) {
        try {
            const hospitalId = req.query.hospitalId ? parseInt(req.query.hospitalId as string, 10) : undefined;
            const result = await patientRegistrationService.getNextTokenNumber(hospitalId);
            return res.json(ApiResponse.success(result, "Next token generated successfully."));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

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
            const orgId = req.headers["x-org-id"] 
                ? parseInt(req.headers["x-org-id"] as string) 
                : (req.body.organizationId ? parseInt(req.body.organizationId as string) : undefined);
            const hospitalId = req.headers["x-hospital-id"] 
                ? parseInt(req.headers["x-hospital-id"] as string) 
                : (req.body.hospitalId ? parseInt(req.body.hospitalId as string) : (req.query.hospitalId ? parseInt(req.query.hospitalId as string) : undefined));

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

    async getRegistrationLink(req: Request, res: Response) {
        try {
            const { token } = req.params;
            if (!token) {
                return res.status(400).json(ApiResponse.error("Registration token is required."));
            }
            const result = await patientRegistrationService.getRegistrationLinkByToken(token as string);
            return res.json(ApiResponse.success(result, "Registration link retrieved successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async getOrgHospPatients(req: Request, res: Response) {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const pageSize = parseInt(req.query.pageSize as string) || 10;
            const orgId = req.query.organizationId ? parseInt(req.query.organizationId as string) : undefined;
            const hospitalId = req.query.hospitalId ? parseInt(req.query.hospitalId as string) : undefined;
            const search = req.query.search as string | undefined;
            const gender = req.query.gender as string | undefined;
            const status = req.query.status as string | undefined;
            const doctorId = req.query.doctorId as string | undefined;

            if (!orgId) {
                return res.status(400).json(ApiResponse.error("Organization ID is required."));
            }

            // Convert string status to boolean for the repository
            let statusBool: boolean | undefined = undefined;
            if (status === "active") statusBool = true;
            else if (status === "inactive") statusBool = false;

            const result = await patientRegistrationService.getPatients(page, pageSize, {
                organizationId: orgId,
                hospitalId: hospitalId,
                search: search,
                gender: gender,
                status: statusBool,
                doctorId: doctorId
            });


            return res.json(ApiResponse.success(result, "Patients fetched successfully."));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async quickCheck(req: Request, res: Response) {
        try {
            const mobile = req.query.mobile as string | undefined;
            const email = req.query.email as string | undefined;
            const name = req.query.name as string | undefined;
            const globalSearch = req.query.globalSearch === 'true';
            
            const orgId = req.headers["x-org-id"] ? parseInt(req.headers["x-org-id"] as string) : undefined;
            const rawHospId = req.headers["x-hospital-id"] || req.headers["x-hosp-id"];
            const hospitalId = req.query.hospitalId 
                ? parseInt(req.query.hospitalId as string) 
                : (rawHospId ? parseInt(rawHospId as string) : undefined);

            const result = await patientRegistrationService.quickCheck({ mobile, email, name, organizationId: orgId, hospitalId, globalSearch });
            return res.json(ApiResponse.success(result, "Quick check completed successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }
}

export const patientRegistrationController = new PatientRegistrationController();
