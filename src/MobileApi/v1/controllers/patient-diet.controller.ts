import { Request, Response } from "express";
import { patientDietPlanService } from "../../../services/Diet/patient-diet-plan.service.js";

export class MobilePatientDietController {
    /**
     * GET /api/mobile/v1/patient/diet/active-plan
     * Returns the active diet plan for the authenticated patient
     */
    async getActivePlan(req: Request, res: Response) {
        try {
            const patientId = (req as any).user?.userId || (req.query.patientId as string);
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
            const patientId = (req as any).user?.userId || (req.query.patientId as string);
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
     * GET /api/mobile/v1/patient/diet/plan/:planId
     * Returns full diet plan with all meals across all days
     */
    async getPlanDetails(req: Request, res: Response) {
        try {
            const planId = parseInt(String(req.params.planId), 10);
            const plan = await patientDietPlanService.getPlanDetails(planId);

            if (!plan) {
                return res.status(404).json({ error: "Diet plan not found." });
            }

            res.json(plan);
        } catch (error: any) {
            res.status(500).json({ error: error.message || "Failed to fetch plan details." });
        }
    }
}

export const mobilePatientDietController = new MobilePatientDietController();
