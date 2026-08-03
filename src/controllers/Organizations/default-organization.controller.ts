import type { Request, Response } from "express";
import { defaultOrganizationService } from "../../services/Organizations/default-organization.service.js";
import { ApiResponse } from "../../utils/response.utils.js";
import type { CreateDefaultOrganizationRequest } from "../../dtos/Request/Organizations/CreateDefaultOrganizationRequest.js";
import type { UpdateDefaultOrganizationRequest } from "../../dtos/Request/Organizations/UpdateDefaultOrganizationRequest.js";

/**
 * Controller for managing Default Organization endpoints.
 */
export class DefaultOrganizationController {
    /**
     * Set a new Default Organization & Hospital.
     */
    async create(req: Request, res: Response) {
        try {
            const data = req.body as CreateDefaultOrganizationRequest;
            if (!data.OrganizationId || !data.HospitalId) {
                return res.status(400).json(ApiResponse.error("Both OrganizationId and HospitalId are required."));
            }

            const result = await defaultOrganizationService.createDefaultOrganization(data);
            return res.json(ApiResponse.success(result, "Default Organization created and set as active default successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Update an existing Default Organization setting.
     */
    async update(req: Request, res: Response) {
        try {
            const rawId = (req.params as any).id;
            const id = rawId ? parseInt(String(rawId)) : req.body.Id;
            const data = { ...req.body, Id: id } as UpdateDefaultOrganizationRequest;

            if (!data.Id) {
                return res.status(400).json(ApiResponse.error("Default Organization record ID is required for update."));
            }

            const result = await defaultOrganizationService.updateDefaultOrganization(data);
            return res.json(ApiResponse.success(result, "Default Organization updated successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Get current active Default Organization.
     */
    async getActive(req: Request, res: Response) {
        try {
            const result = await defaultOrganizationService.getActiveDefaultOrganization();
            if (!result) {
                return res.json(ApiResponse.success(null, "No active default organization configured."));
            }
            return res.json(ApiResponse.success(result, "Active default organization retrieved successfully."));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Get all Default Organization records history.
     */
    async getAll(req: Request, res: Response) {
        try {
            const result = await defaultOrganizationService.getAllDefaultOrganizations();
            return res.json(ApiResponse.success(result, "Default organization records fetched successfully."));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const defaultOrganizationController = new DefaultOrganizationController();
