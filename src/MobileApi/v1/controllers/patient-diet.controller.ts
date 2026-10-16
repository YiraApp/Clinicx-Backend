import { Request, Response } from "express";
import { patientDietPlanService } from "../../../services/Diet/patient-diet-plan.service.js";
import { DietValidationError } from "../../../services/Diet/diet-validation.js";
import { blobService } from "../../../services/Common/blob.service.js";

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const PHOTO_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"];

/** Some phones send photos as a generic file type, so a photo extension is enough. */
function isPhoto(file: Express.Multer.File): boolean {
    const type = (file.mimetype || "").toLowerCase();
    const name = (file.originalname || "").toLowerCase();
    return PHOTO_TYPES.includes(type) || PHOTO_EXTENSIONS.some(ext => name.endsWith(ext));
}

function signedInPatientId(req: Request): string | undefined {
    const user = (req as any).user;
    const id = user?.userId || user?.Id || user?.id;
    return id ? String(id) : undefined;
}

function planIdParam(req: Request): number | undefined {
    const id = parseInt(String(req.params.planId), 10);
    return Number.isInteger(id) && id > 0 ? id : undefined;
}

/** Validation problems are the patient's to fix (400); anything else is ours (500). */
function sendPatientError(res: Response, error: any, fallback: string, where: string) {
    if (error instanceof DietValidationError) {
        return res.status(400).json({ error: error.message });
    }
    console.error(`Error in ${where}:`, error);
    return res.status(500).json({ error: fallback });
}

export class MobilePatientDietController {
    /**
     * GET /api/mobile/v1/patient/diet/active-plan
     * Returns the active diet plan for the authenticated patient
     */
    async getActivePlan(req: Request, res: Response) {
        try {
            const patientId = signedInPatientId(req);
            if (!patientId) {
                return res.status(401).json({ error: "Patient authentication required." });
            }

            const activePlan = await patientDietPlanService.getActivePlanForPatient(patientId);
            if (!activePlan) {
                return res.json({ hasActivePlan: false, plan: null });
            }

            res.json({
                hasActivePlan: true,
                plan: activePlan
            });
        } catch (error: any) {
            console.error("Error in getActivePlan:", error);
            res.status(500).json({ error: error.message || "Failed to fetch active diet plan." });
        }
    }

    /**
     * GET /api/mobile/v1/patient/diet/today
     * Returns today's meals based on current day of cycle with nutritional macro breakdown
     */
    async getTodayMeals(req: Request, res: Response) {
        try {
            const patientId = signedInPatientId(req);
            if (!patientId) {
                return res.status(401).json({ error: "Patient authentication required." });
            }

            const todayData = await patientDietPlanService.getTodayMealsForPatient(patientId);
            res.json(todayData);
        } catch (error: any) {
            console.error("Error in getTodayMeals:", error);
            res.status(500).json({ error: error.message || "Failed to fetch today's meals." });
        }
    }

    /**
     * GET /plan/:planId
     * Full plan with every day's meals, only for the signed-in patient's own plan
     */
    async getPlanDetails(req: Request, res: Response) {
        try {
            const patientId = signedInPatientId(req);
            if (!patientId) {
                return res.status(401).json({ error: "Patient authentication required." });
            }
            const planId = parseInt(String(req.params.planId), 10);
            if (!Number.isInteger(planId)) {
                return res.status(400).json({ error: "Invalid plan id." });
            }

            const plan = await patientDietPlanService.getPlanDetailsForPatient(planId, patientId);
            if (!plan) {
                return res.status(404).json({ error: "Diet plan not found." });
            }

            res.json(plan);
        } catch (error: any) {
            console.error("Error in getPlanDetails:", error);
            res.status(500).json({ error: "Failed to fetch plan details." });
        }
    }

    /**
     * PUT /my-plan/:planId
     * The patient saves changes to the meals of their own active plan
     */
    async updateMyPlan(req: Request, res: Response) {
        try {
            const patientId = signedInPatientId(req);
            if (!patientId) {
                return res.status(401).json({ error: "Patient authentication required." });
            }
            const planId = parseInt(String(req.params.planId), 10);
            if (!Number.isInteger(planId)) {
                return res.status(400).json({ error: "Invalid plan id." });
            }

            const plan = await patientDietPlanService.updatePlanByPatient(planId, patientId, req.body);
            res.json(plan);
        } catch (error: any) {
            if (error instanceof DietValidationError) {
                return res.status(400).json({ error: error.message });
            }
            console.error("Error in updateMyPlan:", error);
            res.status(500).json({ error: "Failed to save your diet plan." });
        }
    }

    /** GET /my-plans — every plan prescribed to the signed-in patient */
    async listMyPlans(req: Request, res: Response) {
        try {
            const patientId = signedInPatientId(req);
            if (!patientId) return res.status(401).json({ error: "Patient authentication required." });
            res.json(await patientDietPlanService.listPlansForPatient(patientId));
        } catch (error: any) {
            sendPatientError(res, error, "Failed to load your diet plans.", "listMyPlans");
        }
    }

    /** PUT /my-plans/:planId/status — { status: "active" | "paused" } */
    async setMyPlanStatus(req: Request, res: Response) {
        try {
            const patientId = signedInPatientId(req);
            if (!patientId) return res.status(401).json({ error: "Patient authentication required." });
            const planId = planIdParam(req);
            if (!planId) return res.status(400).json({ error: "Invalid plan id." });
            res.json(await patientDietPlanService.setPlanStatusByPatient(planId, patientId, req.body?.status));
        } catch (error: any) {
            sendPatientError(res, error, "Failed to change the plan.", "setMyPlanStatus");
        }
    }

    /** GET /my-plans/:planId/logs?from=YYYY-MM-DD&to=YYYY-MM-DD */
    async getMealLogs(req: Request, res: Response) {
        try {
            const patientId = signedInPatientId(req);
            if (!patientId) return res.status(401).json({ error: "Patient authentication required." });
            const planId = planIdParam(req);
            if (!planId) return res.status(400).json({ error: "Invalid plan id." });
            res.json(await patientDietPlanService.getMealLogs(planId, patientId, req.query.from, req.query.to));
        } catch (error: any) {
            sendPatientError(res, error, "Failed to load your meal records.", "getMealLogs");
        }
    }

    /** PUT /my-plans/:planId/logs — { planMealId, date, isEaten?, removePhoto? } */
    async saveMealLog(req: Request, res: Response) {
        try {
            const patientId = signedInPatientId(req);
            if (!patientId) return res.status(401).json({ error: "Patient authentication required." });
            const planId = planIdParam(req);
            if (!planId) return res.status(400).json({ error: "Invalid plan id." });
            res.json(await patientDietPlanService.saveMealLog(planId, patientId, req.body));
        } catch (error: any) {
            sendPatientError(res, error, "Failed to save the meal.", "saveMealLog");
        }
    }

    /** POST /my-plans/:planId/logs/photo — multipart: photo, planMealId, date */
    async uploadMealPhoto(req: Request, res: Response) {
        try {
            const patientId = signedInPatientId(req);
            if (!patientId) return res.status(401).json({ error: "Patient authentication required." });
            const planId = planIdParam(req);
            if (!planId) return res.status(400).json({ error: "Invalid plan id." });

            const file = (req as any).file as Express.Multer.File | undefined;
            if (!file) return res.status(400).json({ error: "Choose a photo to upload." });
            if (!isPhoto(file)) {
                return res.status(400).json({ error: "The photo must be a JPG, PNG, WEBP or HEIC image." });
            }

            // Check everything before uploading, so a rejected request leaves no file behind.
            await patientDietPlanService.assertMealLoggable(planId, patientId, req.body?.planMealId, req.body?.date);
            const [uploaded] = await blobService.uploadFiles([file], patientId, "diet-meals");

            const isEaten = req.body?.isEaten === undefined ? undefined : String(req.body.isEaten) === "true";
            res.json(await patientDietPlanService.saveMealLog(
                planId,
                patientId,
                { planMealId: req.body?.planMealId, date: req.body?.date, isEaten },
                uploaded.fileUrl,
            ));
        } catch (error: any) {
            sendPatientError(res, error, "Failed to upload the photo.", "uploadMealPhoto");
        }
    }

    /** POST /my-plans — the patient creates a plan for themselves */
    async createMyPlan(req: Request, res: Response) {
        try {
            const patientId = signedInPatientId(req);
            if (!patientId) return res.status(401).json({ error: "Patient authentication required." });
            res.status(201).json(await patientDietPlanService.createPlanByPatient(patientId, req.body));
        } catch (error: any) {
            sendPatientError(res, error, "Failed to create your diet plan.", "createMyPlan");
        }
    }

    /** DELETE /my-plans/:planId — only plans the patient created */
    async deleteMyPlan(req: Request, res: Response) {
        try {
            const patientId = signedInPatientId(req);
            if (!patientId) return res.status(401).json({ error: "Patient authentication required." });
            const planId = planIdParam(req);
            if (!planId) return res.status(400).json({ error: "Invalid plan id." });
            res.json(await patientDietPlanService.deletePlanByPatient(planId, patientId));
        } catch (error: any) {
            sendPatientError(res, error, "Failed to delete the plan.", "deleteMyPlan");
        }
    }
}

export const mobilePatientDietController = new MobilePatientDietController();
