import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../utils/jwt.utils.js";

/** The role name the web sidebar and API logging use for Yira's own administrators. */
export const YIRA_SYSTEM_ADMIN_ROLE = "Yira System Admin";

export interface YiraSystemAdminChecks {
    /** The signed-in user's id, or null when the bearer token is missing, invalid, expired or revoked. */
    userIdFromToken(token: string): Promise<string | null>;
    isYiraSystemAdmin(userId: string): Promise<boolean>;
}

const databaseChecks: YiraSystemAdminChecks = {
    async userIdFromToken(token: string) {
        const payload = verifyAccessToken(token);
        if (!payload?.userId) return null;
        const { tokenRepository } = await import("../repositories/Account/token.repository.js");
        const record = await tokenRepository.findByAccessToken(token, String(payload.userId));
        return record && !record.IsRevoked ? String(payload.userId) : null;
    },

    /** An active user holding an active "Yira System Admin" role. */
    async isYiraSystemAdmin(userId: string) {
        const { AppDataSource } = await import("../config/database.js");
        const rows = await AppDataSource.query(
            `SELECT TOP 1 1 AS IsAdmin
             FROM UserRoles ur
             INNER JOIN Roles r ON r.Id = ur.RoleId
             INNER JOIN Users u ON u.Id = ur.UserId
             WHERE ur.UserId = @0 AND ur.IsDeleted = 0 AND ur.Status = 1
               AND u.IsDeleted = 0 AND u.Status = 1
               AND r.RoleName = @1`,
            [userId, YIRA_SYSTEM_ADMIN_ROLE]
        );
        return Array.isArray(rows) && rows.length > 0;
    },
};

/**
 * Only a signed-in Yira System Admin passes. It needs a verified, unrevoked bearer token: unlike
 * authMiddleware it does not accept the x-user-id / x-device-id pair, which anyone can send.
 */
export const createYiraSystemAdminMiddleware = (checks: YiraSystemAdminChecks = databaseChecks) =>
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const header = req.headers.authorization;
            const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
            if (!token) {
                res.status(401).json({ status: false, message: "Sign in to continue.", data: null });
                return;
            }
            const userId = await checks.userIdFromToken(token);
            if (!userId) {
                res.status(401).json({ status: false, message: "Your session has expired. Please sign in again.", data: null });
                return;
            }
            if (!(await checks.isYiraSystemAdmin(userId))) {
                res.status(403).json({ status: false, message: `Only ${YIRA_SYSTEM_ADMIN_ROLE} can view this.`, data: null });
                return;
            }
            (req as any).userId = userId;
            next();
        } catch (error: any) {
            console.error("[CEO dashboard] Access check failed:", error?.message);
            res.status(500).json({ status: false, message: "Your access could not be checked.", data: null });
        }
    };

export const requireYiraSystemAdmin = createYiraSystemAdminMiddleware();
