import type { Request, Response, NextFunction } from "express";
import { ApiResponse } from "../utils/response.utils.js";

/**
 * Guards the ABDM M2 patient routes (/api/abdm/patients/:userId/...), after staffJwtMiddleware.
 * They act for the hospital the desk names in x-hospital-id, as that hospital's ABDM facility, so
 * the database must show the signed-in user holding an active, non-Patient role at that hospital.
 * Without it, staff of one hospital could read, link or text another hospital's patients by
 * changing the header. The desk's own workspace always passes: its x-hospital-id comes from one of
 * the user's role assignments.
 */

export interface HospitalStaffChecks {
    /** Whether the user holds an active, non-Patient role at the hospital. */
    staffWorksAt(userId: string, hospitalId: number): Promise<boolean>;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const databaseChecks: HospitalStaffChecks = {
    async staffWorksAt(userId: string, hospitalId: number) {
        const { abhaRepository } = await import("../repositories/Abdm/abha.repository.js");
        return abhaRepository.staffWorksAt(userId, hospitalId);
    },
};

const refuse = (res: Response, status: number, kind: string, message: string) =>
    res.status(status).json(ApiResponse.error(message, { kind }));

export const createAbdmHospitalStaff = (checks: HospitalStaffChecks = databaseChecks) =>
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const rawHospital = String(req.headers["x-hospital-id"] ?? "").trim();
            const hospitalId = /^\d{1,9}$/.test(rawHospital) ? Number(rawHospital) : 0;
            if (!hospitalId) {
                return refuse(res, 400, "validation", "Switch to a hospital workspace to see its patients' ABDM records. This request did not say which hospital (x-hospital-id).");
            }

            const staffUserId = String((req as any).userId ?? "");
            if (!GUID.test(staffUserId) || !(await checks.staffWorksAt(staffUserId, hospitalId))) {
                return refuse(res, 403, "forbidden", "You don't have a staff role at this hospital, so its patients' ABDM records can't be used here.");
            }
            next();
        } catch (error: any) {
            console.error(`[ABDM] M2 hospital access check failed: ${error?.code ?? error?.name ?? "error"}`);
            return refuse(res, 500, "unexpected", "Your access to this hospital's ABDM records could not be checked. Try again.");
        }
    };

export const abdmHospitalStaff = createAbdmHospitalStaff();
