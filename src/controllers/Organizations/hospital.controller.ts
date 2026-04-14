import type { Request, Response } from "express";
import { hospitalService } from "../../services/Organizations/hospital.service.js";
import { ApiResponse } from "../../utils/response.utils.js";
import type { CreateHospitalRequest, UpdateHospitalRequest } from "../../dtos/Request/Organizations/CreateHospitalRequest.js";

/**
 * Controller for Hospital-related API endpoints.
 */
export class HospitalController {
    /**
     * Handles creation of a new hospital and its linked admin user.
     */
    async create(req: Request, res: Response) {
        try {
            const hospitalData = req.body as CreateHospitalRequest;

            if (!hospitalData.OrganizationId) {
                return res.status(400).json(ApiResponse.error("OrganizationId is required."));
            }

            if (!hospitalData.Name) {
                return res.status(400).json(ApiResponse.error("Hospital Name is required."));
            }

            if (!hospitalData.HospitalCode) {
                return res.status(400).json(ApiResponse.error("Hospital Code is required."));
            }

            if (!hospitalData.HospitalType) {
                return res.status(400).json(ApiResponse.error("Hospital Type is required."));
            }

            if (!hospitalData.MobileNumber) {
                return res.status(400).json(ApiResponse.error("Admin Mobile Number is required."));
            }

            if (!hospitalData.roleId) {
                return res.status(400).json(ApiResponse.error("RoleId is required for hospital admin linkage."));
            }

            const result = await hospitalService.createHospital(hospitalData);
            return res.json(ApiResponse.success(result, "Hospital created and user linked successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Fetches all hospitals, optionally filtered by organization.
     */
    async getAll(req: Request, res: Response) {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const pageSize = parseInt(req.query.pageSize as string) || 10;
            const orgId = req.query.orgId ? parseInt(req.query.orgId as string) : undefined;
            const grouped = req.query.grouped === "true";

            const result = await hospitalService.getAllHospitals(orgId, page, pageSize, grouped);
            return res.json(ApiResponse.success(result, "Hospitals fetched successfully."));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Fetches a single hospital by its ID.
     */
    async getById(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            if (!id) {
                return res.status(400).json(ApiResponse.error("Valid Hospital ID is required."));
            }

            const result = await hospitalService.getHospitalById(id);
            return res.json(ApiResponse.success(result, "Hospital details fetched successfully."));
        } catch (error: any) {
            return res.status(404).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Handles soft-deleting a hospital.
     */
    async delete(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            if (!id) {
                return res.status(400).json(ApiResponse.error("Valid Hospital ID is required for deletion."));
            }

            await hospitalService.deleteHospital(id);
            return res.json(ApiResponse.success(null, "Hospital deleted successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Handles updating an existing hospital.
     */
    async update(req: Request, res: Response) {
        try {
            const hospitalData = req.body as UpdateHospitalRequest;

            if (!hospitalData.Id) {
                return res.status(400).json(ApiResponse.error("Hospital ID is required for update."));
            }

            const result = await hospitalService.updateHospital(hospitalData);
            return res.json(ApiResponse.success(result, "Hospital updated successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }
}

export const hospitalController = new HospitalController();
