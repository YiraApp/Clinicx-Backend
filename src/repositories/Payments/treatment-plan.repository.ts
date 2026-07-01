import { AppDataSource } from "../../config/database.js";
import { TreatmentPlan } from "../../models/Payments/treatment-plan.model.js";
import { v4 as uuidv4 } from "uuid";

export class TreatmentPlanRepository {
    private repo = AppDataSource.getRepository(TreatmentPlan);

    async findByOrgAndHospital(orgId: number, hospitalId?: number, search: string = ""): Promise<TreatmentPlan[]> {
        const qb = this.repo.createQueryBuilder("t")
            .where("t.OrgId = :orgId", { orgId })
            .andWhere("t.IsDeleted = :isDeleted", { isDeleted: false });

        if (hospitalId) {
            qb.andWhere("(t.HospitalId = :hospitalId OR t.HospitalId IS NULL)", { hospitalId });
        } else {
            qb.andWhere("t.HospitalId IS NULL");
        }

        if (search) {
            qb.andWhere("t.Name LIKE :search", { search: `%${search}%` });
        }

        qb.orderBy("t.CreatedAt", "DESC");
        return await qb.getMany();
    }

    async findById(planId: string): Promise<TreatmentPlan | null> {
        return await this.repo.findOne({
            where: { TreatmentPlanId: planId, IsDeleted: false }
        });
    }

    async createPlan(data: Partial<TreatmentPlan>): Promise<TreatmentPlan> {
        const plan = this.repo.create({
            TreatmentPlanId: uuidv4(),
            OrgId: data.OrgId,
            HospitalId: data.HospitalId || null,
            Name: data.Name,
            Description: data.Description || null,
            Amount: data.Amount || 0,
            Status: data.Status || "Active",
            CreatedAt: new Date()
        });
        return await this.repo.save(plan);
    }

    async updatePlan(planId: string, data: Partial<TreatmentPlan>): Promise<TreatmentPlan | null> {
        const plan = await this.findById(planId);
        if (!plan) return null;

        if (data.Name !== undefined) plan.Name = data.Name;
        if (data.Description !== undefined) plan.Description = data.Description;
        if (data.Amount !== undefined) plan.Amount = data.Amount;
        if (data.Status !== undefined) plan.Status = data.Status;
        plan.UpdatedAt = new Date();

        return await this.repo.save(plan);
    }

    async deletePlan(planId: string): Promise<boolean> {
        const plan = await this.findById(planId);
        if (!plan) return false;

        plan.IsDeleted = true;
        plan.UpdatedAt = new Date();
        await this.repo.save(plan);
        return true;
    }
}

export const treatmentPlanRepository = new TreatmentPlanRepository();
