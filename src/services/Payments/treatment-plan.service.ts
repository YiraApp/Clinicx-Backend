import { treatmentPlanRepository, isActivePlan } from "../../repositories/Payments/treatment-plan.repository.js";
import { TreatmentPlan } from "../../models/Payments/treatment-plan.model.js";

export class TreatmentPlanService {
    /** activeOnly: for booking, where an Inactive plan must not be offered. */
    async getPlans(orgId: number, hospitalId?: number, search: string = "", activeOnly: boolean = false): Promise<TreatmentPlan[]> {
        return await treatmentPlanRepository.findByOrgAndHospital(orgId, hospitalId, search, activeOnly);
    }

    /** Plans attached to a new booking must exist and be Active; otherwise the booking is refused. */
    async assertBookable(planIds: string[] | undefined | null): Promise<void> {
        const ids = Array.from(new Set((planIds || []).map(id => String(id || "").trim()).filter(Boolean)));
        if (ids.length === 0) return;
        const plans = await treatmentPlanRepository.findByIds(ids);
        const found = new Map(plans.map(p => [p.TreatmentPlanId.toLowerCase(), p]));
        const missing = ids.filter(id => !found.has(id.toLowerCase()));
        if (missing.length > 0) {
            throw new Error("A selected treatment plan no longer exists. Remove it and book again.");
        }
        const inactive = plans.filter(p => !isActivePlan(p));
        if (inactive.length > 0) {
            throw new Error(`${inactive.map(p => `"${p.Name}"`).join(", ")} ${inactive.length === 1 ? "is" : "are"} inactive and can't be added to an appointment. Remove ${inactive.length === 1 ? "it" : "them"} and book again.`);
        }
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
