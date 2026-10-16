import type { SelectQueryBuilder } from "typeorm/index.js";
import { AppDataSource } from "../../config/database.js";
import { DietTemplate } from "../../models/Diet/diet-template.model.js";
import { DietTemplateMeal } from "../../models/Diet/diet-template-meal.model.js";
import {
    DietValidationError,
    optionalText,
    requireText,
    validateMeals,
    validateTargets,
    validateTotalDays,
    type DietMealPayload,
} from "./diet-validation.js";

const DIET_TYPES = ["Veg", "Non-Veg", "Eggetarian", "Vegan"];

function doctorSummary(doctor?: { Id: string; FirstName?: string | null; LastName?: string | null } | null) {
    if (!doctor) return undefined;
    const name = [doctor.FirstName, doctor.LastName].filter(Boolean).join(" ").trim();
    return { Id: doctor.Id, Name: name || undefined };
}

/**
 * Templates belong to the doctor who saved them. Other doctors in the same
 * organization or hospital do not see them unless the owner shares them.
 * System starter templates are visible to everyone and are read-only.
 */
export class DietTemplateService {
    private templateRepo = AppDataSource.getRepository(DietTemplate);
    private mealRepo = AppDataSource.getRepository(DietTemplateMeal);

    private withOwnership<T extends DietTemplate>(template: T, doctorId?: string) {
        const isMine = !!doctorId
            && !template.IsSystemDefault
            && String(template.CreatedByDoctorId || "").toLowerCase() === doctorId.toLowerCase();
        return { ...template, IsMine: isMine };
    }

    /** System templates, the doctor's own templates, and ones explicitly shared in their organization. */
    private applyVisibility(qb: SelectQueryBuilder<DietTemplate>, organizationId?: number, doctorId?: string) {
        if (doctorId && organizationId) {
            qb.andWhere(
                "(t.IsSystemDefault = 1 OR t.CreatedByDoctorId = :docId OR (t.OrganizationId = :orgId AND t.IsOrganizationShared = 1))",
                { docId: doctorId, orgId: organizationId }
            );
        } else if (doctorId) {
            qb.andWhere("(t.IsSystemDefault = 1 OR t.CreatedByDoctorId = :docId)", { docId: doctorId });
        } else {
            qb.andWhere("t.IsSystemDefault = 1");
        }
    }

    async listTemplates(params: {
        organizationId?: number;
        doctorId?: string;
        condition?: string;
        dietType?: string;
        search?: string;
        scope?: string;
    }) {
        const { organizationId, doctorId, condition, dietType, search, scope } = params;

        const qb = this.templateRepo.createQueryBuilder("t")
            .leftJoinAndSelect("t.Doctor", "doctor")
            .where("t.IsActive = :isActive", { isActive: 1 });

        this.applyVisibility(qb, organizationId, doctorId);

        if (scope === "mine") {
            if (!doctorId) return [];
            qb.andWhere("t.CreatedByDoctorId = :mineId AND t.IsSystemDefault = 0", { mineId: doctorId });
        } else if (scope === "system") {
            qb.andWhere("t.IsSystemDefault = 1");
        } else {
            // Doctors pick from templates doctors saved; the built-in presets
            // are only listed when asked for explicitly (scope=system).
            qb.andWhere("t.IsSystemDefault = 0");
        }

        if (condition && condition !== "All") {
            qb.andWhere("t.Condition = :condition", { condition });
        }

        if (dietType && dietType !== "All") {
            qb.andWhere("t.DietType = :dietType", { dietType });
        }

        if (search && search.trim() !== "") {
            const term = `%${search.trim().toLowerCase()}%`;
            qb.andWhere("(LOWER(t.Name) LIKE :term OR LOWER(t.Description) LIKE :term OR LOWER(t.Condition) LIKE :term)", { term });
        }

        qb.orderBy("t.IsSystemDefault", "ASC")
          .addOrderBy("COALESCE(t.UpdatedAt, t.CreatedAt)", "DESC");

        const templates = await qb.getMany();
        if (templates.length === 0) return [];

        const templateIds = templates.map(t => t.Id);
        const mealCounts = await this.mealRepo
            .createQueryBuilder("m")
            .select("m.TemplateId", "templateId")
            .addSelect("COUNT(m.Id)", "count")
            .where("m.TemplateId IN (:...templateIds)", { templateIds })
            .groupBy("m.TemplateId")
            .getRawMany();

        const countMap = new Map<number, number>();
        mealCounts.forEach(mc => countMap.set(Number(mc.templateId), parseInt(mc.count, 10)));

        return templates.map(t => ({
            ...this.withOwnership(t, doctorId),
            Doctor: doctorSummary(t.Doctor),
            MealCount: countMap.get(t.Id) || 0
        }));
    }

    async getTemplateById(id: number, organizationId?: number, doctorId?: string) {
        const qb = this.templateRepo.createQueryBuilder("t")
            .leftJoinAndSelect("t.Doctor", "doctor")
            .leftJoinAndSelect("t.Meals", "meals")
            .leftJoinAndSelect("meals.FoodItem", "foodItem")
            .where("t.Id = :id AND t.IsActive = 1", { id });

        this.applyVisibility(qb, organizationId, doctorId);

        qb.orderBy("meals.DayNumber", "ASC")
          .addOrderBy("meals.SortOrder", "ASC")
          .addOrderBy("meals.MealTime", "ASC");

        const template = await qb.getOne();
        if (!template) return null;
        return {
            ...this.withOwnership(template, doctorId),
            Doctor: doctorSummary(template.Doctor),
        };
    }

    /** Loads a template the doctor owns, or explains why they cannot change it. */
    private async findOwnedTemplate(id: number, doctorId?: string) {
        if (!doctorId) {
            throw new DietValidationError("Sign in as a doctor to manage templates.");
        }
        const existing = await this.templateRepo.findOne({ where: { Id: id, IsActive: true } });
        if (!existing) {
            throw new DietValidationError("Template not found.");
        }
        if (existing.IsSystemDefault) {
            throw new DietValidationError("System templates cannot be changed. Copy it to My Templates to customize it.");
        }
        if (String(existing.CreatedByDoctorId || "").toLowerCase() !== doctorId.toLowerCase()) {
            throw new DietValidationError("You can only change templates you created.");
        }
        return existing;
    }

    private async assertUniqueName(name: string, doctorId: string, excludeId?: number) {
        const qb = this.templateRepo.createQueryBuilder("t")
            .where("t.IsActive = 1 AND t.CreatedByDoctorId = :doctorId AND LOWER(t.Name) = :name", {
                doctorId,
                name: name.toLowerCase(),
            });
        if (excludeId) qb.andWhere("t.Id <> :excludeId", { excludeId });
        if (await qb.getCount() > 0) {
            throw new DietValidationError(`You already have a template named "${name}". Choose a different name.`);
        }
    }

    private validateHeader(data: any, existing?: DietTemplate) {
        const name = data.name !== undefined || !existing
            ? requireText(data.name, "Template name", 200)
            : existing.Name;
        const totalDays = data.totalDays !== undefined || !existing
            ? validateTotalDays(data.totalDays, 1)
            : existing.TotalDays;
        const dietType = data.dietType !== undefined ? optionalText(data.dietType, "Diet type", 50) : existing?.DietType;
        if (dietType && !DIET_TYPES.includes(dietType)) {
            throw new DietValidationError(`Diet type must be one of: ${DIET_TYPES.join(", ")}.`);
        }
        return {
            name,
            totalDays,
            dietType: dietType || "Veg",
            description: data.description !== undefined ? optionalText(data.description, "Description", 1000) ?? null : existing?.Description,
            condition: data.condition !== undefined ? optionalText(data.condition, "Medical condition", 100) ?? null : existing?.Condition,
            generalNotes: data.generalNotes !== undefined ? optionalText(data.generalNotes, "Clinical notes", 4000) ?? null : existing?.GeneralNotes,
            ...validateTargets(data),
        };
    }

    private toMealEntities(templateId: number, meals: DietMealPayload[]) {
        return meals.map((m, index) => this.mealRepo.create({
            TemplateId: templateId,
            DayNumber: m.dayNumber || 1,
            MealSlot: m.mealSlot,
            MealTime: m.mealTime,
            FoodItemId: m.foodItemId ?? undefined,
            FoodName: m.foodName,
            Quantity: m.quantity,
            Unit: m.unit || "serving",
            WeightAmount: m.weightAmount ?? undefined,
            WeightUnit: m.weightUnit ?? undefined,
            Calories: m.calories || 0,
            ProteinG: m.proteinG ?? undefined,
            CarbsG: m.carbsG ?? undefined,
            FatG: m.fatG ?? undefined,
            Notes: m.notes ?? undefined,
            SortOrder: m.sortOrder ?? index
        }));
    }

    async createTemplate(data: any) {
        if (!data.organizationId) {
            throw new DietValidationError("OrganizationId is required to create a template.");
        }
        if (!data.doctorId) {
            throw new DietValidationError("Sign in as a doctor to save templates.");
        }

        const header = this.validateHeader(data);
        const meals = validateMeals(data.meals, header.totalDays, { requireAtLeastOne: true });
        await this.assertUniqueName(header.name, data.doctorId);

        const template = this.templateRepo.create({
            Name: header.name,
            Description: header.description ?? undefined,
            Condition: header.condition ?? undefined,
            TotalDays: header.totalDays,
            TargetCalories: header.targetCalories,
            TargetProteinG: header.targetProteinG,
            TargetCarbsG: header.targetCarbsG,
            TargetFatG: header.targetFatG,
            DietType: header.dietType,
            GeneralNotes: header.generalNotes ?? undefined,
            CreatedByDoctorId: data.doctorId,
            OrganizationId: data.organizationId,
            HospitalId: data.hospitalId,
            IsOrganizationShared: data.isOrganizationShared === true,
            IsSystemDefault: false,
            IsActive: true
        });

        const savedTemplate = await this.templateRepo.save(template);
        await this.mealRepo.save(this.toMealEntities(savedTemplate.Id, meals));

        return await this.getTemplateById(savedTemplate.Id, data.organizationId, data.doctorId);
    }

    async updateTemplate(id: number, data: any, organizationId: number, doctorId?: string) {
        const existing = await this.findOwnedTemplate(id, doctorId);
        const header = this.validateHeader(data, existing);

        if (header.name.toLowerCase() !== existing.Name.toLowerCase()) {
            await this.assertUniqueName(header.name, doctorId!, id);
        }

        // Meals are replaced as a whole; without new meals the existing ones must still fit the day count.
        const meals = data.meals !== undefined
            ? validateMeals(data.meals, header.totalDays, { requireAtLeastOne: true })
            : null;
        if (!meals && header.totalDays < existing.TotalDays) {
            const outside = await this.mealRepo.createQueryBuilder("m")
                .where("m.TemplateId = :id AND m.DayNumber > :days", { id, days: header.totalDays })
                .getCount();
            if (outside > 0) {
                throw new DietValidationError(`This template has meals after day ${header.totalDays}. Remove them before reducing the number of days.`);
            }
        }

        existing.Name = header.name;
        existing.Description = header.description ?? undefined;
        existing.Condition = header.condition ?? undefined;
        existing.TotalDays = header.totalDays;
        existing.TargetCalories = header.targetCalories ?? existing.TargetCalories;
        existing.TargetProteinG = header.targetProteinG ?? existing.TargetProteinG;
        existing.TargetCarbsG = header.targetCarbsG ?? existing.TargetCarbsG;
        existing.TargetFatG = header.targetFatG ?? existing.TargetFatG;
        existing.DietType = header.dietType;
        existing.GeneralNotes = header.generalNotes ?? undefined;
        if (typeof data.isOrganizationShared === "boolean") {
            existing.IsOrganizationShared = data.isOrganizationShared;
        }
        existing.UpdatedAt = new Date();

        await AppDataSource.transaction(async (manager) => {
            await manager.save(existing);
            if (meals) {
                await manager.delete(DietTemplateMeal, { TemplateId: id });
                await manager.save(this.toMealEntities(id, meals));
            }
        });

        return await this.getTemplateById(id, organizationId, doctorId);
    }

    async deleteTemplate(id: number, doctorId?: string) {
        const existing = await this.findOwnedTemplate(id, doctorId);
        existing.IsActive = false;
        existing.UpdatedAt = new Date();
        await this.templateRepo.save(existing);
        return { success: true, message: "Template deleted successfully." };
    }

    /** Copies a template the doctor can see into their own templates. */
    async duplicateTemplate(sourceTemplateId: number, organizationId: number, doctorId: string, customName?: string) {
        const source = await this.getTemplateById(sourceTemplateId, organizationId, doctorId);
        if (!source) {
            throw new DietValidationError("Source template not found.");
        }

        const baseName = (customName && customName.trim()) || `${source.Name} (Copy)`;
        let name = requireText(baseName, "Template name", 200);
        for (let n = 2; ; n++) {
            const taken = await this.templateRepo.createQueryBuilder("t")
                .where("t.IsActive = 1 AND t.CreatedByDoctorId = :doctorId AND LOWER(t.Name) = :name", { doctorId, name: name.toLowerCase() })
                .getCount();
            if (!taken) break;
            if (customName && customName.trim()) {
                throw new DietValidationError(`You already have a template named "${name}". Choose a different name.`);
            }
            name = `${source.Name} (Copy ${n})`.slice(0, 200);
        }

        const saved = await this.templateRepo.save(this.templateRepo.create({
            Name: name,
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
        }));

        if (source.Meals && source.Meals.length > 0) {
            await this.mealRepo.save(source.Meals.map(m => this.mealRepo.create({
                TemplateId: saved.Id,
                DayNumber: m.DayNumber,
                MealSlot: m.MealSlot,
                MealTime: m.MealTime,
                FoodItemId: m.FoodItemId,
                FoodName: m.FoodName,
                Quantity: m.Quantity,
                Unit: m.Unit,
                WeightAmount: m.WeightAmount,
                WeightUnit: m.WeightUnit,
                Calories: m.Calories,
                ProteinG: m.ProteinG,
                CarbsG: m.CarbsG,
                FatG: m.FatG,
                Notes: m.Notes,
                SortOrder: m.SortOrder
            })));
        }

        return await this.getTemplateById(saved.Id, organizationId, doctorId);
    }
}

export const dietTemplateService = new DietTemplateService();
