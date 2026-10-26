import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken, type TokenPayload } from "../utils/jwt.utils.js";

/**
 * Requires a verified, unrevoked staff JWT. Unlike authMiddleware it does not accept the
 * x-user-id / x-device-id pair the mobile app sends instead of a token: the routes behind it
 * spend the clinic's ABDM credentials and send OTPs to patients' phones.
 */

export interface StaffJwtChecks {
    verify(token: string): TokenPayload | null;
    isActiveToken(token: string): Promise<boolean>;
    hasStaffRole(userId: string): Promise<boolean>;
}

const databaseChecks: StaffJwtChecks = {
    verify: verifyAccessToken,

    async isActiveToken(token: string) {
        const { tokenRepository } = await import("../repositories/Account/token.repository.js");
        const record = await tokenRepository.findByAccessToken(token);
        return !!record && !record.IsRevoked;
    },

    /** Any active role other than Patient. */
    async hasStaffRole(userId: string) {
        const { AppDataSource } = await import("../config/database.js");
        const rows = await AppDataSource.query(
            `SELECT TOP 1 1 AS HasRole
             FROM UserRoles ur
             INNER JOIN Roles r ON r.Id = ur.RoleId
             WHERE ur.UserId = @0 AND ur.IsDeleted = 0 AND ur.Status = 1 AND r.RoleName <> 'Patient'`,
            [userId]
        );
        return Array.isArray(rows) && rows.length > 0;
    },
};

export const createStaffJwtMiddleware = (checks: StaffJwtChecks = databaseChecks) =>
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const authHeader = req.headers.authorization;
            const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
            if (!token) {
                res.status(401).json({ error: "A signed-in staff account is required." });
                return;
            }

            const payload = checks.verify(token);
            if (!payload?.userId) {
                res.status(401).json({ error: "Access token is invalid or expired" });
                return;
            }
            if (!(await checks.isActiveToken(token))) {
                res.status(401).json({ error: "Token has been revoked" });
                return;
            }
            if (!(await checks.hasStaffRole(String(payload.userId)))) {
                res.status(403).json({ error: "Only clinic staff can use ABHA services." });
                return;
            }

            (req as any).userId = String(payload.userId);
            (req as any).user = payload;
            next();
        } catch (error: any) {
            console.error("[ABDM] Staff authentication failed:", error?.message);
            res.status(401).json({ error: "Authentication failed" });
        }
    };

export const staffJwtMiddleware = createStaffJwtMiddleware();
