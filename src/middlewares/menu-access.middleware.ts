import type { Request, Response, NextFunction } from "express";
import { sidebarRepository } from "../repositories/Common/sidebar.repository.js";
import { ApiResponse } from "../utils/response.utils.js";

/**
 * Middleware to check if the user's selected role has access to
 * at least one sidebar menu matching the given route patterns.
 * @param routePatterns - Substrings to match against sidebar menu Routes (case-insensitive).
 */
export function menuAccessMiddleware(routePatterns: string[]) {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const roleId = req.headers["x-role-id"] as string | undefined;
            const orgId = req.headers["x-org-id"] as string | undefined;
            const hospitalId = req.headers["x-hospital-id"] as string | undefined;

            if (!roleId) {
                res.status(403).json(ApiResponse.error("Access denied: missing role context"));
                return;
            }

            const hasAccess = await sidebarRepository.hasMenuAccess(
                roleId,
                routePatterns,
                orgId ? parseInt(orgId) : null,
                hospitalId ? parseInt(hospitalId) : null
            );

            if (!hasAccess) {
                res.status(403).json(ApiResponse.error("Access denied: insufficient menu permissions"));
                return;
            }

            next();
        } catch (err) {
            console.error("Menu access middleware error:", err);
            res.status(500).json(ApiResponse.error("Internal Server Error"));
        }
    };
}
