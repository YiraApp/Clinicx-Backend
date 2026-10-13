import { AppDataSource } from "../../config/database.js";
import { DietTemplate } from "../../models/Diet/diet-template.model.js";
import { DietTemplateMeal } from "../../models/Diet/diet-template-meal.model.js";

export class DietTemplateService {
    private templateRepo = AppDataSource.getRepository(DietTemplate);
    private mealRepo = AppDataSource.getRepository(DietTemplateMeal);

    /**
     * List templates accessible to an organization.
     * Doctors see: System default templates + Org shared templates + Their own private templates in that Org.
     */
    async listTemplates(params: {
        organizationId?: number;
        doctorId?: string;
        condition?: string;
        dietType?: string;
        search?: string;
    }) {
        const { organizationId, doctorId, condition, dietType, search } = params;

        const qb = this.templateRepo.createQueryBuilder("t")
            .leftJoinAndSelect("t.Doctor", "doctor")
            .where("t.IsActive = :isActive", { isActive: 1 });

        if (organizationId) {
            if (doctorId) {
                // System templates OR (Org templates that are shared OR created by this doctor)
                qb.andWhere(
                    "(t.IsSystemDefault = 1 OR (t.OrganizationId = :orgId AND (t.IsOrganizationShared = 1 OR t.CreatedByDoctorId = :docId)))",
                    { orgId: organizationId, docId: doctorId }
                );
            } else {
                // System templates OR any active template in this Org
                qb.andWhere(
                    "(t.IsSystemDefault = 1 OR t.OrganizationId = :orgId)",
                    { orgId: organizationId }
                );
            }
        } else {
            // Unauthenticated/general: only system default templates
            qb.andWhere("t.IsSystemDefault = 1");
        }

        if (condition && condition !== "All") {
            qb.andWhere("t.Condition = :condition", { condition });
        }

        if (dietType && dietType !== "All") {
            qb.andWhere("t.DietType = :dietType", { dietType });
        }

        if (search && search.trim() !== "") {
            const term = `%${search.trim().toLowerCase()}%`;
            qb.andWhere("(LOWER(t.Name) LIKE :term OR LOWER(t.Description) LIKE :term)", { term });
        }

        qb.orderBy("t.IsSystemDefault", "DESC")
          .addOrderBy("t.CreatedAt", "DESC");

        const templates = await qb.getMany();

        // Get meal counts for each template
        if (templates.length > 0) {
            const templateIds = templates.map(t => t.Id);
            const mealCounts = await this.mealRepo
                .createQueryBuilder("m")
                .select("m.TemplateId", "templateId")
                .addSelect("COUNT(m.Id)", "count")
                .where("m.TemplateId IN (:...templateIds)", { templateIds })
                .groupBy("m.TemplateId")
                .getRawMany();

            const countMap = new Map<number, number>();
            mealCounts.forEach(mc => countMap.set(mc.templateId, parseInt(mc.count, 10)));

            return templates.map(t => ({
                ...t,
                MealCount: countMap.get(t.Id) || 0
            }));
        }

        return templates;
    }

    /**
     * Get single template with all meals ordered by DayNumber, MealTime, SortOrder
     */
    async getTemplateById(id: number, organizationId?: number) {
        const qb = this.templateRepo.createQueryBuilder("t")
            .leftJoinAndSelect("t.Doctor", "doctor")
            .leftJoinAndSelect("t.Meals", "meals")
            .leftJoinAndSelect("meals.FoodItem", "foodItem")
            .where("t.Id = :id AND t.IsActive = 1", { id });

        if (organizationId) {
            qb.andWhere("(t.IsSystemDefault = 1 OR t.OrganizationId = :orgId)", { orgId: organizationId });
        } else {
            qb.andWhere("t.IsSystemDefault = 1");
        }

        qb.orderBy("meals.DayNumber", "ASC")
          .addOrderBy("meals.SortOrder", "ASC")
          .addOrderBy("meals.MealTime", "ASC");

        return await qb.getOne();
    }

    /**
     * Create a new diet template for an organization
     */
    async createTemplate(data: {
        name: string;
        description?: string;
        condition?: string;
        totalDays?: number;
        targetCalories?: number;
        targetProteinG?: number;
        targetCarbsG?: number;
        targetFatG?: number;
        dietType?: string;
        generalNotes?: string;
        isOrganizationShared?: boolean;
        organizationId: number;
        hospitalId?: number;
        doctorId?: string;
        meals?: Array<{
            dayNumber?: number;
            mealSlot: string;
            mealTime: string;
            foodItemId?: number;
            foodName: string;
            quantity: number;
            unit?: string;
            calories?: number;
            proteinG?: number;
            carbsG?: number;
            fatG?: number;
            notes?: string;
            sortOrder?: number;
        }>;
    }) {
        if (!data.organizationId) {
            throw new Error("OrganizationId is required to create a template.");
        }

        const template = this.templateRepo.create({
            Name: data.name,
            Description: data.description,
            Condition: data.condition,
            TotalDays: data.totalDays || 7,
            TargetCalories: data.targetCalories,
            TargetProteinG: data.targetProteinG,
            TargetCarbsG: data.targetCarbsG,
            TargetFatG: data.targetFatG,
            DietType: data.dietType || "Veg",
            GeneralNotes: data.generalNotes,
            CreatedByDoctorId: data.doctorId,
            OrganizationId: data.organizationId,
            HospitalId: data.hospitalId,
            IsOrganizationShared: data.isOrganizationShared ?? false,
            IsSystemDefault: false,
            IsActive: true
        });

        const savedTemplate = await this.templateRepo.save(template);

        if (data.meals && data.meals.length > 0) {
            const mealEntities = data.meals.map((m, index) => this.mealRepo.create({
                TemplateId: savedTemplate.Id,
                DayNumber: m.dayNumber || 1,
                MealSlot: m.mealSlot,
                MealTime: m.mealTime,
                FoodItemId: m.foodItemId,
                FoodName: m.foodName,
                Quantity: m.quantity || 1,
                Unit: m.unit || "serving",
                Calories: m.calories || 0,
                ProteinG: m.proteinG,
                CarbsG: m.carbsG,
                FatG: m.fatG,
                Notes: m.notes,
                SortOrder: m.sortOrder ?? index
            }));

            await this.mealRepo.save(mealEntities);
        }

        return await this.getTemplateById(savedTemplate.Id, data.organizationId);
    }

    /**
     * Update an organization template and its meals
     */
    async updateTemplate(id: number, data: any, organizationId: number) {
        const existing = await this.templateRepo.findOne({ where: { Id: id, IsActive: true } });
        if (!existing) {
            throw new Error("Template not found.");
        }

        if (existing.IsSystemDefault) {
            throw new Error("Platform system starter templates cannot be modified. You can duplicate this template to customize it for your organization.");
        }

        if (existing.OrganizationId !== organizationId) {
            throw new Error("Access denied: You do not have permission to modify this organization's template.");
        }

        // Update scalar fields
        existing.Name = data.name ?? existing.Name;
        existing.Description = data.description ?? existing.Description;
        existing.Condition = data.condition ?? existing.Condition;
        existing.TotalDays = data.totalDays ?? existing.TotalDays;
        existing.TargetCalories = data.targetCalories ?? existing.TargetCalories;
        existing.TargetProteinG = data.targetProteinG ?? existing.TargetProteinG;
        existing.TargetCarbsG = data.targetCarbsG ?? existing.TargetCarbsG;
        existing.TargetFatG = data.targetFatG ?? existing.TargetFatG;
        existing.DietType = data.dietType ?? existing.DietType;
        existing.GeneralNotes = data.generalNotes ?? existing.GeneralNotes;
        existing.IsOrganizationShared = data.isOrganizationShared ?? existing.IsOrganizationShared;
        existing.UpdatedAt = new Date();

        await this.templateRepo.save(existing);

        // If meals provided, replace existing meals
        if (data.meals && Array.isArray(data.meals)) {
            await this.mealRepo.delete({ TemplateId: id });

            const mealEntities = data.meals.map((m: any, index: number) => this.mealRepo.create({
                TemplateId: id,
                DayNumber: m.dayNumber || 1,
                MealSlot: m.mealSlot,
                MealTime: m.mealTime,
                FoodItemId: m.foodItemId,
                FoodName: m.foodName,
                Quantity: m.quantity || 1,
                Unit: m.unit || "serving",
                Calories: m.calories || 0,
                ProteinG: m.proteinG,
                CarbsG: m.carbsG,
                FatG: m.fatG,
                Notes: m.notes,
                SortOrder: m.sortOrder ?? index
            }));

            await this.mealRepo.save(mealEntities);
        }

        return await this.getTemplateById(id, organizationId);
    }

    /**
     * Soft delete an organization template
     */
    async deleteTemplate(id: number, organizationId: number) {
        const existing = await this.templateRepo.findOne({ where: { Id: id, IsActive: true } });
        if (!existing) {
            throw new Error("Template not found.");
        }

        if (existing.IsSystemDefault) {
            throw new Error("Platform system starter templates cannot be deleted.");
        }

        if (existing.OrganizationId !== organizationId) {
            throw new Error("Access denied: You do not have permission to delete this organization's template.");
        }

        existing.IsActive = false;
        existing.UpdatedAt = new Date();
        await this.templateRepo.save(existing);

        return { success: true, message: "Template deleted successfully." };
    }

    /**
     * Duplicate a template (system or org template) into a doctor's personal org template
     */
    async duplicateTemplate(sourceTemplateId: number, organizationId: number, doctorId: string, customName?: string) {
        const source = await this.getTemplateById(sourceTemplateId, organizationId);
        if (!source) {
            throw new Error("Source template not found.");
        }

        const newName = customName || `${source.Name} (Copy)`;

        const newTemplate = this.templateRepo.create({
            Name: newName,
            Description: source.Description,
            Condition: source.Condition,
            TotalDays: source.TotalDays,
            TargetCalories: source.TargetCalories,
            TargetProteinG: source.TargetProteinG,
            TargetCarbsG: source.TargetCarbsG,
            TargetFatG: source.TargetFatG,
            DietType: source.DietType,
            GeneralNotes: source.GeneralNotes,
            CreatedByDoctorId: doctorId,
            OrganizationId: organizationId,
            HospitalId: source.HospitalId,
            IsOrganizationShared: false,
            IsSystemDefault: false,
            IsActive: true
        });

        const saved = await this.templateRepo.save(newTemplate);

        if (source.Meals && source.Meals.length > 0) {
            const clonedMeals = source.Meals.map(m => this.mealRepo.create({
                TemplateId: saved.Id,
                DayNumber: m.DayNumber,
                MealSlot: m.MealSlot,
                MealTime: m.MealTime,
                FoodItemId: m.FoodItemId,
                FoodName: m.FoodName,
                Quantity: m.Quantity,
                Unit: m.Unit,
                Calories: m.Calories,
                ProteinG: m.ProteinG,
                CarbsG: m.CarbsG,
                FatG: m.FatG,
                Notes: m.Notes,
                SortOrder: m.SortOrder
            }));

            await this.mealRepo.save(clonedMeals);
        }

        return await this.getTemplateById(saved.Id, organizationId);
    }
}

export const dietTemplateService = new DietTemplateService();
