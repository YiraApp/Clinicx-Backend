import type { Request, Response } from "express";
import { sidebarService } from "../../services/Common/sidebar.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

/**
 * Controller for Sidebar-related endpoints.
 */
export const getSidebar = async (req: Request, res: Response) => {
    try {
        const { roleId, orgId, hospId } = req.query;

        if (!roleId) {
            return res.status(400).json(ApiResponse.error("RoleId is required"));
        }

        const menu = await sidebarService.getSidebarMenu(
            roleId as string,
            orgId ? parseInt(orgId as string) : null,
            hospId ? parseInt(hospId as string) : null
        );

        return res.json(ApiResponse.success(menu, "Sidebar menu fetched successfully"));
    } catch (error: any) {
        return res.status(500).json(ApiResponse.error(error.message));
    }
};
