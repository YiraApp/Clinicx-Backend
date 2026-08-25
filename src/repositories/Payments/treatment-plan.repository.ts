import { AppDataSource } from "../../config/database.js";
import { TreatmentPlan } from "../../models/Payments/treatment-plan.model.js";
import { v4 as uuidv4 } from "uuid";

export class TreatmentPlanRepository {
    private repo = AppDataSource.getRepository(TreatmentPlan);

    async findByOrgAndHospital(orgId: number, hospitalId?: number, search: string = ""): Promise<TreatmentPlan[]> {
        const qb = this.repo.createQueryBuilder("t")
            .where("(t.OrgId = :orgId OR t.OrgId IS NULL)", { orgId })
            .andWhere("t.IsDeleted = :isDeleted", { isDeleted: false });

        if (hospitalId) {
            qb.andWhere("(t.HospitalId = :hospitalId OR t.HospitalId IS NULL)", { hospitalId });
        }

        if (search && search.trim() !== "") {
            qb.andWhere("(t.Name LIKE :search OR t.Description LIKE :search)", { search: `%${search.trim()}%` });
        }

        qb.orderBy("t.CreatedAt", "DESC");
        let plans = await qb.getMany();

        // If no plans exist yet for this org, automatically seed standard healthcare treatment plans
        if (plans.length === 0 && (!search || search.trim() === "")) {
            const defaultPlans = [
                { Name: "General Consultation", Description: "Comprehensive primary physical examination & health review", Amount: 500 },
                { Name: "Follow-up Consultation", Description: "Progress evaluation and prescription adjustments", Amount: 300 },
                { Name: "Diagnostic Blood Panel", Description: "Complete blood count, lipid profile & routine biochemistry", Amount: 850 },
                { Name: "ECG & Cardiac Screening", Description: "12-lead Electrocardiogram screening and rhythm analysis", Amount: 600 },
                { Name: "Wound Care & Sterile Dressing", Description: "Antiseptic cleaning, sterile dressing and minor suture care", Amount: 400 },
                { Name: "Dental Scaling & Polishing", Description: "Ultrasonic tartar removal and enamel polishing", Amount: 1200 },
                { Name: "Physiotherapy Session", Description: "Targeted musculoskeletal therapy and rehabilitation exercises", Amount: 750 },
                { Name: "Vaccination & Immunization", Description: "Standard preventive immunization administration", Amount: 450 }
            ];

            for (const dp of defaultPlans) {
                const newPlan = this.repo.create({
                    TreatmentPlanId: uuidv4(),
                    OrgId: orgId || 1,
                    HospitalId: hospitalId || null,
                    Name: dp.Name,
                    Description: dp.Description,
                    Amount: dp.Amount,
                    Status: "Active",
                    CreatedAt: new Date(),
                    IsDeleted: false
                });
                try {
                    await this.repo.save(newPlan);
                } catch (e) {
                    console.error("Error auto-seeding treatment plan:", e);
                }
            }

            plans = await qb.getMany();
        }

        return plans;
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
