import type { Request, Response } from "express";
import { organizationService } from "../../services/Organizations/organization.service.js";
import { ApiResponse } from "../../utils/response.utils.js";
import type { CreateOrganizationRequest } from "../../dtos/Request/Organizations/CreateOrganizationRequest.js";
import type { UpdateOrganizationRequest } from "../../dtos/Request/Organizations/UpdateOrganizationRequest.js";

/**
 * Controller for Organization-related API endpoints.
 */
export class OrganizationController {
    /**
     * Handles creation of a new organization and its linked admin user.
     */
    async create(req: Request, res: Response) {
        try {
            const orgData = req.body as CreateOrganizationRequest;

            if (!orgData.roleId) {
                return res.status(400).json(ApiResponse.error("RoleId is required for organization creation."));
            }

            const result = await organizationService.createOrganization(orgData, orgData.roleId);
            return res.json(ApiResponse.success(result, "Organization created and user linked successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Handles updating an existing organization.
     */
    async update(req: Request, res: Response) {
        try {
            const orgData = req.body as UpdateOrganizationRequest;

            if (!orgData.Id) {
                return res.status(400).json(ApiResponse.error("Organization ID is required for update."));
            }

            const result = await organizationService.updateOrganization(orgData);
            return res.json(ApiResponse.success(result, "Organization updated successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Handles fetching all organizations.
     */
    async getAll(req: Request, res: Response) {
        try {
            const page = parseInt((req.query.page || req.query.PageNumber) as string) || 1;
            const pageSize = parseInt((req.query.pageSize || req.query.limit || req.query.PageSize) as string) || 1000;
            const orgId = req.query.orgId || req.query.OrgId ? parseInt((req.query.orgId || req.query.OrgId) as string) : undefined;
            const type = req.query.type as string | undefined;
            const search = req.query.search as string | undefined;

            const result = await organizationService.getAllOrganizations(page, pageSize, orgId, type, search);
            return res.json(ApiResponse.success(result, "Organizations fetched successfully."));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const organizationController = new OrganizationController();
