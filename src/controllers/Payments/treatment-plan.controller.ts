import { Request, Response } from "express";
import { treatmentPlanService } from "../../services/Payments/treatment-plan.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class TreatmentPlanController {
    async getPlans(req: Request, res: Response) {
        try {
            const { orgId, hospitalId, search } = req.query;
            if (!orgId) {
                return res.status(400).json(ApiResponse.error("Organization ID is required"));
            }
            const data = await treatmentPlanService.getPlans(
                parseInt(orgId as string),
                hospitalId ? parseInt(hospitalId as string) : undefined,
                search as string || ""
            );
            return res.json(ApiResponse.success(data, "Treatment plans fetched successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async createPlan(req: Request, res: Response) {
        try {
            const data = await treatmentPlanService.createPlan(req.body);
            return res.status(201).json(ApiResponse.success(data, "Treatment plan created successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async updatePlan(req: Request, res: Response) {
        try {
            const planId = req.params.planId as string;
            const data = await treatmentPlanService.updatePlan(planId, req.body);
            return res.json(ApiResponse.success(data, "Treatment plan updated successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async deletePlan(req: Request, res: Response) {
        try {
            const planId = req.params.planId as string;
            await treatmentPlanService.deletePlan(planId);
            return res.json(ApiResponse.success(null, "Treatment plan deleted successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }
}

export const treatmentPlanController = new TreatmentPlanController();
