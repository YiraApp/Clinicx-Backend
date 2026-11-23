import type { Request, Response } from "express";
import { ApiResponse } from "../../utils/response.utils.js";
import { hospitalPatientRemovalRepository } from "../../repositories/Organizations/hospital-patient-removal.repository.js";
import {
    HospitalPatientRemovalService,
    PatientRemovalError,
} from "../../services/Organizations/hospital-patient-removal.service.js";

/** The hospital the Front Desk user is working at: the body's, else the query's, else the X-Hospital-Id header. */
export const hospitalIdOf = (req: Request): number => {
    const raw = req.body?.hospitalId ?? req.query?.hospitalId ?? req.headers?.["x-hospital-id"];
    const value = Number(Array.isArray(raw) ? raw[0] : raw);
    return Number.isInteger(value) ? value : NaN;
};

const intOf = (value: unknown, fallback: number): number => {
    const parsed = parseInt(String(value ?? ""), 10);
    return Number.isInteger(parsed) ? parsed : fallback;
};

/**
 * Front Desk's patient removal, restore, ABHA unlink and Deleted patients list. Mounted behind
 * staffJwtMiddleware, which puts the signed-in user's id on req.userId; the service checks they
 * are Front Desk at the hospital.
 */
export const createHospitalPatientRemovalController = (service: HospitalPatientRemovalService) => {
    const answer = async (res: Response, action: string, work: () => Promise<unknown>, message: string) => {
        try {
            res.json(ApiResponse.success(await work(), message));
        } catch (error: any) {
            if (error instanceof PatientRemovalError) {
                res.status(error.status).json(ApiResponse.error(error.message));
                return;
            }
            console.error(`[Patient removal] ${action} failed:`, error?.message);
            res.status(500).json(ApiResponse.error(`Could not ${action}. Please try again.`));
        }
    };

    return {
        remove: (req: Request, res: Response) => answer(res, "remove the patient",
            () => service.remove((req as any).userId, String(req.params.userId), hospitalIdOf(req)),
            "Patient removed from this hospital."),

        restore: (req: Request, res: Response) => answer(res, "restore the patient",
            () => service.restore((req as any).userId, String(req.params.userId), hospitalIdOf(req)),
            "Patient restored to this hospital."),

        unlinkAbha: (req: Request, res: Response) => answer(res, "unlink the ABHA",
            () => service.unlinkAbha((req as any).userId, String(req.params.userId), hospitalIdOf(req)),
            "ABHA unlinked from this patient."),

        listRemoved: (req: Request, res: Response) => answer(res, "load the deleted patients",
            () => service.listRemoved(
                (req as any).userId,
                hospitalIdOf(req),
                intOf(req.query.page, 1),
                intOf(req.query.pageSize, 20),
                typeof req.query.search === "string" ? req.query.search : undefined
            ),
            "Deleted patients fetched."),
    };
};

export const hospitalPatientRemovalController = createHospitalPatientRemovalController(
    new HospitalPatientRemovalService(hospitalPatientRemovalRepository)
);
