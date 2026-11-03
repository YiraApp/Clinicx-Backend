import type { Request, Response } from "express";
import { AppDataSource } from "../../config/database.js";
import { hospitalLabTestService } from "../../services/Organizations/hospital-lab-test.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

/** Hospital admins of this hospital, admins of its organization, and system admins. */
async function canManage(userId: string, hospitalId: number): Promise<boolean> {
    const rows = await AppDataSource.query(
        `SELECT TOP 1 1 AS ok
         FROM UserRoles ur
         JOIN Roles r ON r.Id = ur.RoleId
         LEFT JOIN Hospitals h ON h.Id = @1
         WHERE ur.UserId = @0 AND ur.IsDeleted = 0 AND r.RoleName LIKE '%Admin%'
           AND (r.RoleName LIKE '%System%' OR ur.HospitalId = @1
                OR (r.RoleName LIKE '%Org%' AND ur.OrganizationId = h.OrganizationId))`,
        [userId, hospitalId]
    );
    return rows.length > 0;
}

const hospitalIdOf = (req: Request) => Number(req.params.hospitalId);

class HospitalLabTestController {
    private async guard(req: Request, res: Response): Promise<number | null> {
        const hospitalId = hospitalIdOf(req);
        const userId = String((req as any).user?.userId || "");
        if (!Number.isInteger(hospitalId) || hospitalId <= 0) {
            res.status(400).json(ApiResponse.error("Hospital ID is required."));
            return null;
        }
        if (!userId || !(await canManage(userId, hospitalId))) {
            res.status(403).json(ApiResponse.error("Only this hospital's admins can change its lab tests."));
            return null;
        }
        return hospitalId;
    }

    async list(req: Request, res: Response) {
        try {
            const hospitalId = hospitalIdOf(req);
            if (!Number.isInteger(hospitalId) || hospitalId <= 0) {
                return res.status(400).json(ApiResponse.error("Hospital ID is required."));
            }
            const includeInactive = req.query.includeInactive === "true";
            const search = typeof req.query.search === "string" ? req.query.search : undefined;
            return res.json(ApiResponse.success(await hospitalLabTestService.list(hospitalId, { includeInactive, search }), "Lab tests fetched successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async create(req: Request, res: Response) {
        try {
            const hospitalId = await this.guard(req, res);
            if (hospitalId === null) return;
            return res.status(201).json(ApiResponse.success(await hospitalLabTestService.create(hospitalId, req.body), "Lab test added."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async update(req: Request, res: Response) {
        try {
            const hospitalId = await this.guard(req, res);
            if (hospitalId === null) return;
            return res.json(ApiResponse.success(await hospitalLabTestService.update(hospitalId, Number(req.params.id), req.body), "Lab test updated."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async remove(req: Request, res: Response) {
        try {
            const hospitalId = await this.guard(req, res);
            if (hospitalId === null) return;
            await hospitalLabTestService.remove(hospitalId, Number(req.params.id));
            return res.json(ApiResponse.success(null, "Lab test removed."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }
}

export const hospitalLabTestController = new HospitalLabTestController();
