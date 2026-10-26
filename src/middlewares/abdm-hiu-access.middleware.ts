import type { Request, Response, NextFunction } from "express";
import { abdmConfig } from "../config/abdm.config.js";
import { ApiResponse } from "../utils/response.utils.js";
import type { StaffContext } from "../services/Abdm/hiu/hiu-consent.service.js";

/**
 * Guards the HIU staff API (/api/abdm/hiu), after staffJwtMiddleware. The caller must name a
 * hospital in x-hospital-id, and the database must show the signed-in user holding an active role
 * at that hospital whose name is in ABDM_HIU_ROLE_NAMES (case-insensitive). The role headers the
 * browser sends (x-role-name, x-role-id) are never consulted. On success the verified StaffContext
 * is attached to the request for the controller; every query behind it is filtered by that hospital.
 */

export interface HiuAccessChecks {
    /** The configured role names that may use the HIU pages. */
    roleNames(): string[];
    /**
     * The hospital's organization when [userId] holds an active role named in [roleNames] at
     * [hospitalId]; null when the user holds no such role there (or the hospital does not exist).
     */
    staffAccess(userId: string, hospitalId: number, roleNames: string[]): Promise<{ organizationId: number | null } | null>;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The access query and its parameters: @0 user, @1 hospital, @2.. the role names upper-cased,
 * matched against the trimmed role name or its normalized name.
 */
export const hiuAccessQuery = (userId: string, hospitalId: number, roleNames: string[]): { sql: string; parameters: unknown[] } => {
    const names = [...new Set(roleNames.map((name) => name.trim().toUpperCase()).filter(Boolean))];
    const list = names.map((_, index) => `@${index + 2}`).join(", ");
    return {
        sql: `SELECT TOP 1 h.OrganizationId
             FROM UserRoles ur
             INNER JOIN Roles r ON r.Id = ur.RoleId
             INNER JOIN Hospitals h ON h.Id = ur.HospitalId
             WHERE ur.UserId = @0 AND ur.HospitalId = @1 AND ur.IsDeleted = 0 AND ur.Status = 1
               AND ISNULL(h.IsDeleted, 0) = 0
               AND (UPPER(LTRIM(RTRIM(r.RoleName))) IN (${list}) OR UPPER(LTRIM(RTRIM(r.NormalizedName))) IN (${list}))`,
        parameters: [userId, hospitalId, ...names],
    };
};

const databaseChecks: HiuAccessChecks = {
    roleNames: () => abdmConfig.hiuRoleNames,

    async staffAccess(userId: string, hospitalId: number, roleNames: string[]) {
        if (roleNames.length === 0) return null;
        const { AppDataSource } = await import("../config/database.js");
        const { sql, parameters } = hiuAccessQuery(userId, hospitalId, roleNames);
        const rows = await AppDataSource.query(sql, parameters);
        const row = Array.isArray(rows) ? rows[0] : null;
        if (!row) return null;
        const organizationId = Number(row.OrganizationId);
        return { organizationId: Number.isInteger(organizationId) && organizationId > 0 ? organizationId : null };
    },
};

/** The verified staff context abdmHiuAccess attached, or null when the guard did not run. */
export const hiuStaffContext = (req: Request): StaffContext | null => (req as any).hiuStaff ?? null;

const refuse = (res: Response, status: number, kind: string, message: string) =>
    res.status(status).json(ApiResponse.error(message, { kind }));

export const createAbdmHiuAccess = (checks: HiuAccessChecks = databaseChecks) =>
    async (req: Request, res: Response, next: NextFunction) => {
        // Every HIU staff response, refusals included, stays out of browser and proxy caches.
        res.setHeader("Cache-Control", "no-store");
        try {
            const rawHospital = String(req.headers["x-hospital-id"] ?? "").trim();
            const hospitalId = /^\d{1,9}$/.test(rawHospital) ? Number(rawHospital) : 0;
            if (!hospitalId) {
                return refuse(res, 400, "validation", "Switch to a hospital workspace first. This request did not say which hospital (x-hospital-id).");
            }

            const staffUserId = String((req as any).userId ?? "");
            if (!GUID.test(staffUserId)) {
                return refuse(res, 403, "forbidden", "Only clinic staff can use ABDM record requests.");
            }

            const access = await checks.staffAccess(staffUserId, hospitalId, checks.roleNames());
            if (!access) {
                return refuse(res, 403, "forbidden", "Your role at this hospital can't use ABDM record requests.");
            }

            const context: StaffContext = { staffUserId, hospitalId, organizationId: access.organizationId };
            (req as any).hiuStaff = context;
            next();
        } catch (error: any) {
            console.error(`[ABDM HIU] access check failed: ${error?.code ?? error?.name ?? "error"}`);
            return refuse(res, 500, "unexpected", "Your access to ABDM record requests could not be checked. Try again.");
        }
    };

export const abdmHiuAccess = createAbdmHiuAccess();
