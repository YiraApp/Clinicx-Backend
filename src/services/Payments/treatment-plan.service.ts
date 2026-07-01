import { treatmentPlanRepository } from "../../repositories/Payments/treatment-plan.repository.js";
import { TreatmentPlan } from "../../models/Payments/treatment-plan.model.js";

export class TreatmentPlanService {
    async getPlans(orgId: number, hospitalId?: number, search: string = ""): Promise<TreatmentPlan[]> {
        return await treatmentPlanRepository.findByOrgAndHospital(orgId, hospitalId, search);
    }

    async createPlan(data: Partial<TreatmentPlan>): Promise<TreatmentPlan> {
        return await treatmentPlanRepository.createPlan(data);
    }

    async updatePlan(planId: string, data: Partial<TreatmentPlan>): Promise<TreatmentPlan> {
        const updated = await treatmentPlanRepository.updatePlan(planId, data);
        if (!updated) {
            throw new Error("Treatment plan not found or already deleted");
        }
        return updated;
    }

    async deletePlan(planId: string): Promise<boolean> {
        const deleted = await treatmentPlanRepository.deletePlan(planId);
        if (!deleted) {
            throw new Error("Treatment plan not found or already deleted");
        }
        return deleted;
    }
}

export const treatmentPlanService = new TreatmentPlanService();
