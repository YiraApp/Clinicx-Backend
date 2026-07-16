import type { Request, Response } from "express";
import { sidebarService } from "../../services/Common/sidebar.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

/**
 * Controller for Sidebar-related endpoints.
 */
export const getSidebar = async (req: Request, res: Response) => {
    try {
        const { roleId, orgId, hospId, platform } = req.query;

        if (!roleId) {
            return res.status(400).json(ApiResponse.error("RoleId is required"));
        }

        let menu;
        if (platform === "mobile") {
            menu = await sidebarService.getMobileSidebarMenu(
                roleId as string,
                orgId ? parseInt(orgId as string) : null,
                hospId ? parseInt(hospId as string) : null
            );
        } else {
            menu = await sidebarService.getSidebarMenu(
                roleId as string,
                orgId ? parseInt(orgId as string) : null,
                hospId ? parseInt(hospId as string) : null
            );
        }

        return res.json(ApiResponse.success(menu, "Sidebar menu fetched successfully"));
    } catch (error: any) {
        return res.status(500).json(ApiResponse.error(error.message));
    }
};

/**
 * Fetches all available sidebar menus.
 */
export const getAllMenus = async (req: Request, res: Response) => {
    try {
        const { platform } = req.query;
        let menus;
        if (platform === "mobile") {
            menus = await sidebarService.getAllMobileMenus();
        } else {
            menus = await sidebarService.getAllMenus();
        }
        return res.json(ApiResponse.success(menus, "All menus fetched successfully"));
    } catch (error: any) {
        return res.status(500).json(ApiResponse.error(error.message));
    }
};

/**
 * Assigns menus to a specific role, optionally scoped by organization or hospital.
 */
export const assignSidebarPermissions = async (req: Request, res: Response) => {
    try {
        const { roleId, menuIds, orgId, hospId, platform } = req.body;

        if (!roleId) {
            return res.status(400).json(ApiResponse.error("RoleId is required"));
        }

        if (!Array.isArray(menuIds)) {
            return res.status(400).json(ApiResponse.error("menuIds must be an array of numbers"));
        }

        if (platform === "mobile") {
            await sidebarService.updateMobileSidebarPermissions(
                roleId,
                menuIds,
                orgId ? parseInt(orgId) : null,
                hospId ? parseInt(hospId) : null
            );
        } else {
            await sidebarService.updateSidebarPermissions(
                roleId,
                menuIds,
                orgId ? parseInt(orgId) : null,
                hospId ? parseInt(hospId) : null
            );
        }

        return res.json(ApiResponse.success(null, "Sidebar permissions assigned successfully"));
    } catch (error: any) {
        return res.status(500).json(ApiResponse.error(error.message));
    }
};

/**
 * Creates a new menu item, optionally with nested children.
 */
export const createMenu = async (req: Request, res: Response) => {
    try {
        const { platform, ...menuData } = req.body;
        let menu;
        if (platform === "mobile") {
            menu = await sidebarService.createMobileMenu(menuData);
        } else {
            menu = await sidebarService.createMenu(menuData);
        }
        return res.status(201).json(ApiResponse.success(menu, "Menu created successfully"));
    } catch (error: any) {
        return res.status(500).json(ApiResponse.error(error.message));
    }
};

/**
 * Updates an existing menu item.
 */
export const updateMenu = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { platform, ...menuData } = req.body;
        let menu;
        if (platform === "mobile" || req.query.platform === "mobile") {
            menu = await sidebarService.updateMobileMenu(parseInt(id as string), menuData);
        } else {
            menu = await sidebarService.updateMenu(parseInt(id as string), menuData);
        }
        return res.json(ApiResponse.success(menu, "Menu updated successfully"));
    } catch (error: any) {
        return res.status(500).json(ApiResponse.error(error.message));
    }
};

/**
 * Deletes a menu item (Soft delete).
 */
export const deleteMenu = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { platform } = req.query;
        if (platform === "mobile") {
            await sidebarService.deleteMobileMenu(parseInt(id as string));
        } else {
            await sidebarService.deleteMenu(parseInt(id as string));
        }
        return res.json(ApiResponse.success(null, "Menu deleted successfully"));
    } catch (error: any) {
        return res.status(500).json(ApiResponse.error(error.message));
    }
};
