import type { Request, Response } from "express";
import { roleService } from "../../services/Account/role.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

/**
 * Controller for Role-related API endpoints.
 */
export const getRoles = async (req: Request, res: Response) => {
    try {
        const roles = await roleService.getActiveRoles();
        return res.json(ApiResponse.success(roles, "Roles retrieved successfully"));
    } catch (error: any) {
        return res.status(500).json(ApiResponse.error("Failed to retrieve roles", error.message));
    }
};
