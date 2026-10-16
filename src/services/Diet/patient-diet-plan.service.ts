import { AppDataSource } from "../../config/database.js";
import { PatientDietPlan } from "../../models/Diet/patient-diet-plan.model.js";
import { PatientDietPlanMeal } from "../../models/Diet/patient-diet-plan-meal.model.js";
import { PatientDietMealLog } from "../../models/Diet/patient-diet-meal-log.model.js";
import { DietTemplate } from "../../models/Diet/diet-template.model.js";
import { pushNotificationService } from "../Notifications/push-notification.service.js";
import {
    DietValidationError,
    optionalText,
    requireText,
    validateDateRange,
    validateMeals,
    validatePlanStatus,
    validateTargets,
    validateTotalDays,
    type DietMealPayload,
} from "./diet-validation.js";

function personName(user?: { FirstName?: string | null; LastName?: string | null } | null) {
    return [user?.FirstName, user?.LastName].filter(Boolean).join(" ").trim();
}

/**
 * The doctor as shown alongside a plan. Plans are loaded with the doctor's
 * user row, which includes login data, so only the name ever leaves here.
 */
function doctorSummary(user?: { Id?: string; FirstName?: string | null; LastName?: string | null } | null) {
    if (!user) return null;
    return { Id: user.Id, FirstName: user.FirstName ?? null, LastName: user.LastName ?? null, Name: personName(user) || null };
}

function withSafeDoctor<T extends { AssignedByDoctor?: any }>(plan: T): T {
    return { ...plan, AssignedByDoctor: doctorSummary(plan.AssignedByDoctor) };
}

/** "YYYY-MM-DD" for a date column value, which may come back as a Date or a string. */
function dateOnly(value?: Date | string | null): string | null {
    if (!value) return null;
    if (typeof value === "string") return value.slice(0, 10);
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
}

function utcDay(date: string): number {
    const [y, m, d] = date.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** Today's date on the server, in UTC. */
function serverToday(): string {
    return new Date().toISOString().slice(0, 10);
}

/** Checks a "YYYY-MM-DD" date sent by the app. */
function parseLogDate(value: unknown, label = "Date"): string {
    const text = typeof value === "string" ? value.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(utcDay(text)) || dateOnly(new Date(`${text}T00:00:00Z`)) !== text) {
        throw new DietValidationError(`${label} must be a valid date (YYYY-MM-DD).`);
    }
    return text;
}

/** Which day of the plan's rotation falls on [date]; null before the plan starts. */
function rotationDayFor(plan: { StartDate: Date | string; TotalDays: number }, date: string): number | null {
    const start = dateOnly(plan.StartDate);
    if (!start) return null;
    const diff = utcDay(date) - utcDay(start);
    if (diff < 0) return null;
    const cycle = plan.TotalDays > 0 ? plan.TotalDays : 1;
    return (diff % cycle) + 1;
}

function parseJsonList(value?: string | null): string[] {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return value.split(",").map(v => v.trim()).filter(Boolean);
    }
}

function toJsonList(value: unknown, label: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    const list = typeof value === "string" ? parseJsonList(value) : value;
    if (!Array.isArray(list)) throw new DietValidationError(`${label} must be a list.`);
    const cleaned = Array.from(new Set(list.map(v => String(v).trim()).filter(Boolean)));
    if (cleaned.some(v => v.length > 100)) throw new DietValidationError(`Each item in ${label.toLowerCase()} must be 100 characters or fewer.`);
    if (cleaned.length > 50) throw new DietValidationError(`${label} can have at most 50 items.`);
    return JSON.stringify(cleaned);
}

export class PatientDietPlanService {
    private planRepo = AppDataSource.getRepository(PatientDietPlan);
    private mealRepo = AppDataSource.getRepository(PatientDietPlanMeal);
    private templateRepo = AppDataSource.getRepository(DietTemplate);
    private logRepo = AppDataSource.getRepository(PatientDietMealLog);

    /**
     * Assign a diet plan to a patient (from template OR manual meal construction).
     * Enforces organization scoping and deep-copies meals into PatientDietPlanMeals.
     */
    async assignPlan(data: {
        patientId: string;
        doctorId: string;
        organizationId: number;
        hospitalId?: number;
        appointmentId?: number;
        sourceTemplateId?: number;
        planName: string;
        description?: string;
        condition?: string;
        totalDays?: number;
        startDate?: string | Date;
        endDate?: string | Date;
        targetCalories?: number;
        targetProteinG?: number;
        targetCarbsG?: number;
        targetFatG?: number;
        dietType?: string;
        doctorNotes?: string;
        foodsToAvoid?: string[] | string;
        foodsToPrefer?: string[] | string;
        meals?: Array<{
            dayNumber?: number;
            mealSlot: string;
            mealTime: string;
            foodItemId?: number;
            foodName: string;
            quantity: number;
            unit?: string;
            weightAmount?: number;
            weightUnit?: string;
            calories?: number;
            proteinG?: number;
            carbsG?: number;
            fatG?: number;
            notes?: string;
            sortOrder?: number;
        }>;
    }) {
        if (!data.organizationId) {
            throw new DietValidationError("OrganizationId is required to assign a diet plan.");
        }
        if (!data.patientId || !String(data.patientId).trim()) {
            throw new DietValidationError("Select a patient before assigning a diet plan.");
        }
        if (!data.doctorId) {
            throw new DietValidationError("DoctorId is required.");
        }

        const patient = await AppDataSource.query(`SELECT TOP 1 Id FROM Users WHERE Id = @0`, [data.patientId]).catch(() => []);
        if (!patient.length) {
            throw new DietValidationError("Patient not found. Check the patient and try again.");
        }

        const planName = requireText(data.planName, "Plan title", 200);
        const totalDays = validateTotalDays(data.totalDays, 1);
        const targets = validateTargets(data);
        const { start, end } = validateDateRange(data.startDate, data.endDate);
        const avoidJson = toJsonList(data.foodsToAvoid, "Foods to avoid");
        const preferJson = toJsonList(data.foodsToPrefer, "Foods to prefer");

        // Meals come from the request, or are copied from the source template when none are sent.
        let mealsToInsert: DietMealPayload[] = validateMeals(data.meals, totalDays);
        if (mealsToInsert.length === 0 && data.sourceTemplateId) {
            const template = await this.templateRepo.findOne({
                where: { Id: data.sourceTemplateId, IsActive: true },
                relations: ["Meals"]
            });
            mealsToInsert = validateMeals((template?.Meals || []).map(m => ({
                dayNumber: m.DayNumber,
                mealSlot: m.MealSlot,
                mealTime: m.MealTime,
                foodItemId: m.FoodItemId,
                foodName: m.FoodName,
                quantity: m.Quantity,
                unit: m.Unit,
                weightAmount: m.WeightAmount,
                weightUnit: m.WeightUnit,
                calories: m.Calories,
                proteinG: m.ProteinG,
                carbsG: m.CarbsG,
                fatG: m.FatG,
                notes: m.Notes,
                sortOrder: m.SortOrder
            })), Math.max(totalDays, template?.TotalDays || 1));
        }
        if (mealsToInsert.length === 0) {
            throw new DietValidationError("Add at least one food item to the plan.");
        }

        const newPlan = this.planRepo.create({
            PatientId: data.patientId,
            AssignedByDoctorId: data.doctorId,
            OrganizationId: data.organizationId,
            HospitalId: data.hospitalId,
            AppointmentId: data.appointmentId,
            SourceTemplateId: data.sourceTemplateId,
            PlanName: planName,
            Description: optionalText(data.description, "Description", 1000),
            Condition: optionalText(data.condition, "Medical condition", 100),
            TotalDays: Math.max(totalDays, ...mealsToInsert.map(m => m.dayNumber || 1)),
            StartDate: start ?? new Date(),
            EndDate: end,
            TargetCalories: targets.targetCalories,
            TargetProteinG: targets.targetProteinG,
            TargetCarbsG: targets.targetCarbsG,
            TargetFatG: targets.targetFatG,
            DietType: optionalText(data.dietType, "Diet type", 50) || "Veg",
            DoctorNotes: optionalText(data.doctorNotes, "Doctor's notes", 4000),
            FoodsToAvoid: avoidJson,
            FoodsToPrefer: preferJson,
            Status: "active"
        });

        // Replacing the previous active plan and saving the new one succeed or fail together.
        const savedPlan = await AppDataSource.transaction(async (manager) => {
            await manager.update(
                PatientDietPlan,
                { PatientId: data.patientId, OrganizationId: data.organizationId, Status: "active" },
                { Status: "completed", UpdatedAt: new Date() }
            );
            const plan = await manager.save(newPlan);
            await manager.save(this.toMealEntities(plan.Id, mealsToInsert));
            return plan;
        });

        // Notify patient on mobile via Push Notification
        try {
            const doctorUser = await AppDataSource.query(`SELECT FirstName, LastName FROM Users WHERE Id = @0`, [data.doctorId]);
            const doctorFullName = personName(doctorUser[0]);
            const doctorName = doctorFullName ? `Dr. ${doctorFullName}` : "Your Doctor";

            await pushNotificationService.sendNotification({
                userId: data.patientId,
                senderId: data.doctorId,
                title: "🥗 New Diet Plan Prescribed",
                body: `${doctorName} has assigned your personalized diet plan: "${planName}". Tap to view your daily meal schedule.`,
                type: "DIET_PLAN",
                route: "/diet-plan",
                referenceId: String(savedPlan.Id),
                additionalData: {
                    planId: savedPlan.Id,
                    planName: savedPlan.PlanName,
                    organizationId: data.organizationId
                }
            });
        } catch (notifErr) {
            console.error("⚠️ [DietPlanService] Error sending push notification:", notifErr);
        }

        return await this.getPlanDetails(savedPlan.Id, data.organizationId);
    }

    /**
     * Get all diet plans for a patient within an organization, or every plan
     * (all organizations, self-made too) when [options.fullHistory] is set.
     */
    async getPatientPlans(patientId: string, organizationId?: number, options: { fullHistory?: boolean } = {}) {
        const qb = this.planRepo.createQueryBuilder("p")
            .leftJoinAndSelect("p.AssignedByDoctor", "doctor")
            .leftJoinAndSelect("p.Organization", "org")
            .leftJoinAndSelect("p.Hospital", "hospital")
            .where("p.PatientId = :patientId", { patientId });

        // Plans patients make for themselves are private to them, unless they
        // shared their full history with this doctor (checked by the caller).
        if (!options.fullHistory) {
            qb.andWhere("p.CreatedByPatient = 0");
        }

        if (organizationId && !options.fullHistory) {
            qb.andWhere("p.OrganizationId = :orgId", { orgId: organizationId });
        }

        qb.orderBy("p.CreatedAt", "DESC");

        return (await qb.getMany()).map(withSafeDoctor);
    }

    /**
     * Get full details of a specific diet plan with all meals
     */
    async getPlanDetails(planId: number, organizationId?: number) {
        const qb = this.planRepo.createQueryBuilder("p")
            .leftJoinAndSelect("p.AssignedByDoctor", "doctor")
            .leftJoinAndSelect("p.Organization", "org")
            .leftJoinAndSelect("p.Hospital", "hospital")
            .leftJoinAndSelect("p.Meals", "meals")
            .leftJoinAndSelect("meals.FoodItem", "foodItem")
            .where("p.Id = :planId", { planId });

        if (organizationId) {
            qb.andWhere("p.OrganizationId = :orgId", { orgId: organizationId });
        }

        qb.orderBy("meals.DayNumber", "ASC")
          .addOrderBy("meals.SortOrder", "ASC")
          .addOrderBy("meals.MealTime", "ASC");

        const plan = await qb.getOne();
        return plan ? withSafeDoctor(plan) : null;
    }

    private toMealEntities(planId: number, meals: DietMealPayload[]) {
        return meals.map((m, index) => this.mealRepo.create({
            PlanId: planId,
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

    /**
     * Update an assigned diet plan (doctor / clinic)
     */
    async updatePlan(planId: number, data: any, organizationId: number) {
        const existing = await this.planRepo.findOne({ where: { Id: planId } });
        if (!existing) {
            throw new DietValidationError("Diet plan not found.");
        }

        if (existing.OrganizationId !== organizationId) {
            throw new DietValidationError("Access denied: You cannot modify a diet plan belonging to another organization.");
        }
        if (existing.CreatedByPatient) {
            throw new DietValidationError("The patient created this plan themselves, so only they can change it.");
        }

        if (data.planName !== undefined) existing.PlanName = requireText(data.planName, "Plan title", 200);
        if (data.description !== undefined) existing.Description = optionalText(data.description, "Description", 1000);
        if (data.condition !== undefined) existing.Condition = optionalText(data.condition, "Medical condition", 100);
        if (data.totalDays !== undefined) existing.TotalDays = validateTotalDays(data.totalDays, existing.TotalDays);
        const { start, end } = validateDateRange(data.startDate ?? existing.StartDate, data.endDate ?? existing.EndDate);
        if (start) existing.StartDate = start;
        if (data.endDate !== undefined) existing.EndDate = end;
        const targets = validateTargets(data);
        existing.TargetCalories = targets.targetCalories ?? existing.TargetCalories;
        existing.TargetProteinG = targets.targetProteinG ?? existing.TargetProteinG;
        existing.TargetCarbsG = targets.targetCarbsG ?? existing.TargetCarbsG;
        existing.TargetFatG = targets.targetFatG ?? existing.TargetFatG;
        if (data.dietType !== undefined) existing.DietType = optionalText(data.dietType, "Diet type", 50) || existing.DietType;
        if (data.doctorNotes !== undefined) existing.DoctorNotes = optionalText(data.doctorNotes, "Doctor's notes", 4000);
        if (data.foodsToAvoid !== undefined) existing.FoodsToAvoid = toJsonList(data.foodsToAvoid, "Foods to avoid");
        if (data.foodsToPrefer !== undefined) existing.FoodsToPrefer = toJsonList(data.foodsToPrefer, "Foods to prefer");
        existing.UpdatedAt = new Date();

        const meals = data.meals !== undefined
            ? validateMeals(data.meals, existing.TotalDays, { requireAtLeastOne: true })
            : null;

        await AppDataSource.transaction(async (manager) => {
            await manager.save(existing);
            if (meals) {
                await manager.delete(PatientDietPlanMeal, { PlanId: planId });
                await manager.save(this.toMealEntities(planId, meals));
            }
        });

        return await this.getPlanDetails(planId, organizationId);
    }

    /**
     * Patient: change the meals of their own active plan. Doctor-set fields
     * (title, targets, dates, guidance) stay as prescribed.
     */
    async updatePlanByPatient(planId: number, patientId: string, data: any) {
        const existing = await this.planRepo.findOne({ where: { Id: planId } });
        if (!existing || String(existing.PatientId).toLowerCase() !== String(patientId).toLowerCase()) {
            throw new DietValidationError("Diet plan not found.");
        }
        if (!existing.CreatedByPatient) {
            throw new DietValidationError("This diet plan was prescribed by your doctor and cannot be modified.");
        }
        if (existing.Status !== "active") {
            throw new DietValidationError("Only your active diet plan can be edited.");
        }
        if (data?.meals === undefined) {
            throw new DietValidationError("Nothing to save. Send the updated meals.");
        }

        const meals = validateMeals(data.meals, existing.TotalDays, { requireAtLeastOne: true });
        const now = new Date();
        existing.UpdatedAt = now;
        existing.PatientModifiedAt = now;

        await AppDataSource.transaction(async (manager) => {
            await manager.save(existing);
            await manager.delete(PatientDietPlanMeal, { PlanId: planId });
            await manager.save(this.toMealEntities(planId, meals));
        });

        return await this.getPlanDetailsForPatient(planId, patientId);
    }

    /** A plan's full details, only if it belongs to [patientId]. */
    async getPlanDetailsForPatient(planId: number, patientId: string) {
        const plan = await this.getPlanDetails(planId);
        if (!plan || String(plan.PatientId).toLowerCase() !== String(patientId).toLowerCase()) return null;
        return plan;
    }

    /**
     * Change plan status: active | completed | paused | cancelled
     */
    async updatePlanStatus(planId: number, status: string, organizationId?: number) {
        const nextStatus = validatePlanStatus(status);
        const existing = await this.planRepo.findOne({ where: { Id: planId } });
        if (!existing) {
            throw new DietValidationError("Diet plan not found.");
        }

        const currentStatus = (existing.Status || "").trim().toLowerCase();
        if (currentStatus === nextStatus) {
            return { success: true, message: `Diet plan is already ${nextStatus}.` };
        }

        if (organizationId && existing.OrganizationId && existing.OrganizationId !== organizationId) {
            console.warn(`[updatePlanStatus] Note: plan ${planId} org is ${existing.OrganizationId}, request sent org ${organizationId}`);
        }

        await AppDataSource.transaction(async (manager) => {
            // A patient follows one active plan at a time.
            if (nextStatus === "active") {
                await manager.createQueryBuilder()
                    .update(PatientDietPlan)
                    .set({ Status: "paused", UpdatedAt: new Date() })
                    .where("PatientId = :patientId AND Status = 'active' AND Id <> :planId", {
                        patientId: existing.PatientId,
                        planId: existing.Id
                    })
                    .execute();
            }
            existing.Status = nextStatus;
            existing.UpdatedAt = new Date();
            await manager.save(existing);
        });

        return { success: true, message: `Diet plan status updated to ${nextStatus}.` };
    }

    /**
     * Mobile Patient: Get current active diet plan
     */
    async getActivePlanForPatient(patientId: string) {
        const plan = await this.planRepo.createQueryBuilder("p")
            .leftJoinAndSelect("p.AssignedByDoctor", "doctor")
            .leftJoinAndSelect("p.Organization", "org")
            .leftJoinAndSelect("p.Hospital", "hospital")
            .where("p.PatientId = :patientId AND p.Status = 'active'", { patientId })
            .orderBy("p.CreatedAt", "DESC")
            .getOne();

        if (!plan) return null;

        // Calculate current day in cycle
        const now = new Date();
        const start = new Date(plan.StartDate);
        const diffDays = Math.max(0, Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
        const currentDayNumber = (diffDays % (plan.TotalDays || 7)) + 1;

        return {
            ...withSafeDoctor(plan),
            CurrentDayNumber: currentDayNumber,
            DaysSinceStart: diffDays
        };
    }

    /**
     * Mobile Patient: Get today's meals grouped by slot with macro totals
     */
    async getTodayMealsForPatient(patientId: string) {
        const activePlan = await this.getActivePlanForPatient(patientId);
        if (!activePlan) {
            return { hasActivePlan: false, message: "No active diet plan assigned." };
        }

        const currentDay = activePlan.CurrentDayNumber;

        // Fetch meals for current day
        const meals = await this.mealRepo.createQueryBuilder("m")
            .leftJoinAndSelect("m.FoodItem", "foodItem")
            .where("m.PlanId = :planId AND m.DayNumber = :dayNumber", {
                planId: activePlan.Id,
                dayNumber: currentDay
            })
            .orderBy("m.SortOrder", "ASC")
            .addOrderBy("m.MealTime", "ASC")
            .getMany();

        // Group by meal slot
        const slotsOrder = [
            "Early Morning",
            "Breakfast",
            "Mid-Morning",
            "Lunch",
            "Evening Snack",
            "Dinner",
            "Bedtime"
        ];

        const groupedMeals: Record<string, typeof meals> = {};
        slotsOrder.forEach(slot => { groupedMeals[slot] = []; });

        let totalCalories = 0;
        let totalProtein = 0;
        let totalCarbs = 0;
        let totalFat = 0;

        for (const m of meals) {
            if (!groupedMeals[m.MealSlot]) {
                groupedMeals[m.MealSlot] = [];
            }
            groupedMeals[m.MealSlot].push(m);

            totalCalories += m.Calories || 0;
            totalProtein += m.ProteinG || 0;
            totalCarbs += m.CarbsG || 0;
            totalFat += m.FatG || 0;
        }

        return {
            hasActivePlan: true,
            plan: {
                id: activePlan.Id,
                planName: activePlan.PlanName,
                doctorName: activePlan.CreatedByPatient ? "You" : (personName((activePlan as any).AssignedByDoctor) || "Doctor"),
                createdByPatient: !!activePlan.CreatedByPatient,
                organizationName: (activePlan as any).Organization?.Name || "Clinic",
                hospitalName: (activePlan as any).Hospital?.Name || null,
                condition: activePlan.Condition,
                dietType: activePlan.DietType,
                doctorNotes: activePlan.DoctorNotes,
                foodsToAvoid: parseJsonList(activePlan.FoodsToAvoid),
                foodsToPrefer: parseJsonList(activePlan.FoodsToPrefer),
                targetCalories: activePlan.TargetCalories,
                targetProteinG: activePlan.TargetProteinG,
                targetCarbsG: activePlan.TargetCarbsG,
                targetFatG: activePlan.TargetFatG,
                totalDays: activePlan.TotalDays,
                currentDayNumber: currentDay,
                startDate: activePlan.StartDate,
                endDate: activePlan.EndDate,
                patientModifiedAt: activePlan.PatientModifiedAt ?? null,
                canEdit: !!activePlan.CreatedByPatient
            },
            summary: {
                totalCalories: Math.round(totalCalories),
                totalProteinG: Math.round(totalProtein * 10) / 10,
                totalCarbsG: Math.round(totalCarbs * 10) / 10,
                totalFatG: Math.round(totalFat * 10) / 10
            },
            // Doctors can add their own slot names (e.g. "Snacks"); list those after the standard ones.
            slots: [...slotsOrder, ...Object.keys(groupedMeals).filter(slot => !slotsOrder.includes(slot))].map(slot => ({
                slotName: slot,
                time: groupedMeals[slot][0]?.MealTime || "",
                meals: groupedMeals[slot]
            })).filter(s => s.meals.length > 0)
        };
    }

    // --- Patient: all plans, switching plans on and off ---

    /** Loads a plan only if it belongs to [patientId]. */
    private async findPatientPlan(planId: number, patientId: string) {
        const plan = await this.planRepo.findOne({ where: { Id: planId } });
        if (!plan || String(plan.PatientId).toLowerCase() !== String(patientId).toLowerCase()) {
            throw new DietValidationError("Diet plan not found.");
        }
        return plan;
    }

    /** Every plan prescribed to the patient, the active one first. */
    async listPlansForPatient(patientId: string) {
        const plans = await this.planRepo.createQueryBuilder("p")
            .leftJoinAndSelect("p.AssignedByDoctor", "doctor")
            .leftJoinAndSelect("p.Organization", "org")
            .leftJoinAndSelect("p.Hospital", "hospital")
            .where("p.PatientId = :patientId", { patientId })
            .orderBy("p.CreatedAt", "DESC")
            .getMany();

        const counts = new Map<number, number>();
        if (plans.length > 0) {
            const rows = await this.mealRepo.createQueryBuilder("m")
                .select("m.PlanId", "planId")
                .addSelect("COUNT(m.Id)", "count")
                .where("m.PlanId IN (:...ids)", { ids: plans.map(p => p.Id) })
                .groupBy("m.PlanId")
                .getRawMany();
            rows.forEach(r => counts.set(Number(r.planId), parseInt(r.count, 10)));
        }

        const today = serverToday();
        const rank = (status: string) => ({ active: 0, paused: 1, completed: 2, cancelled: 3 } as Record<string, number>)[(status || "").trim().toLowerCase()] ?? 4;

        return plans
            .map(p => {
                const endDate = dateOnly(p.EndDate);
                const isExpired = !!endDate && endDate < today;
                const status = (p.Status || "active").trim().toLowerCase();
                return {
                    id: p.Id,
                    planName: p.PlanName,
                    description: p.Description ?? null,
                    condition: p.Condition ?? null,
                    dietType: p.DietType,
                    status: status,
                    startDate: dateOnly(p.StartDate),
                    endDate,
                    totalDays: p.TotalDays,
                    targetCalories: p.TargetCalories ?? null,
                    targetProteinG: p.TargetProteinG ?? null,
                    targetCarbsG: p.TargetCarbsG ?? null,
                    targetFatG: p.TargetFatG ?? null,
                    doctorName: p.CreatedByPatient ? "You" : (personName((p as any).AssignedByDoctor) || "Doctor"),
                    createdByPatient: !!p.CreatedByPatient,
                    organizationName: (p as any).Organization?.Name || "Clinic",
                    hospitalName: (p as any).Hospital?.Name || null,
                    mealCount: counts.get(p.Id) || 0,
                    isExpired,
                    canActivate: status !== "active" && status !== "cancelled" && !isExpired,
                    canDeactivate: status === "active",
                    createdAt: p.CreatedAt,
                    patientModifiedAt: p.PatientModifiedAt ?? null,
                };
            })
            .sort((a, b) => rank(a.status) - rank(b.status));
    }

    /**
     * The patient turns a plan on or off. The reply uses `planStatus`, not
     * `status`: the mobile app treats a top-level `status` as a true/false
     * success flag. Only one plan is followed at a time,
     * so turning one on pauses whichever plan was active.
     */
    async setPlanStatusByPatient(planId: number, patientId: string, status: unknown) {
        const next = typeof status === "string" ? status.trim().toLowerCase() : "";
        if (next !== "active" && next !== "paused") {
            throw new DietValidationError("Status must be either active or paused.");
        }

        const plan = await this.findPatientPlan(planId, patientId);
        const currentStatus = (plan.Status || "").trim().toLowerCase();
        if (currentStatus === next) {
            return { success: true, planStatus: next, message: next === "active" ? "This plan is already active." : "This plan is already paused." };
        }

        if (next === "paused") {
            if (currentStatus !== "active") throw new DietValidationError("Only an active plan can be paused.");
            plan.Status = "paused";
            plan.UpdatedAt = new Date();
            await this.planRepo.save(plan);
            return { success: true, planStatus: "paused", message: "Diet plan paused." };
        }

        if (currentStatus === "cancelled") {
            throw new DietValidationError("Your doctor stopped this plan, so it can't be turned back on. Ask them to prescribe it again.");
        }
        const endDate = dateOnly(plan.EndDate);
        if (endDate && endDate < serverToday()) {
            throw new DietValidationError(`This plan ended on ${endDate}. Ask your doctor for a new plan.`);
        }

        let pausedCount = 0;
        await AppDataSource.transaction(async (manager) => {
            const result = await manager.createQueryBuilder()
                .update(PatientDietPlan)
                .set({ Status: "paused", UpdatedAt: new Date() })
                .where("PatientId = :patientId AND Status = 'active' AND Id <> :planId", { patientId: plan.PatientId, planId })
                .execute();
            pausedCount = result.affected ?? 0;
            plan.Status = "active";
            plan.UpdatedAt = new Date();
            await manager.save(plan);
        });

        return {
            success: true,
            planStatus: "active",
            pausedOtherPlans: pausedCount,
            message: pausedCount > 0 ? "Diet plan activated. Your previous plan was paused." : "Diet plan activated.",
        };
    }

    // --- Patient: plans they make for themselves ---

    /**
     * A patient builds their own plan, without a prescription. It is private
     * to them, and starts as their active plan unless they say otherwise.
     */
    async createPlanByPatient(patientId: string, data: any) {
        const planName = requireText(data?.planName, "Plan name", 200);
        const totalDays = validateTotalDays(data?.totalDays, 1);
        const dietType = optionalText(data?.dietType, "Diet type", 50) || "Veg";
        const { start, end } = validateDateRange(data?.startDate, data?.endDate);
        if (!start) throw new DietValidationError("Choose a start date.");
        const meals = validateMeals(data?.meals, totalDays, { requireAtLeastOne: true });

        // Daily targets default to the average of the days that have food.
        const dayTotals = new Map<number, { kcal: number; p: number; c: number; f: number }>();
        for (const m of meals) {
            const t = dayTotals.get(m.dayNumber || 1) ?? { kcal: 0, p: 0, c: 0, f: 0 };
            t.kcal += m.calories || 0;
            t.p += m.proteinG || 0;
            t.c += m.carbsG || 0;
            t.f += m.fatG || 0;
            dayTotals.set(m.dayNumber || 1, t);
        }
        const days = Math.max(dayTotals.size, 1);
        const sum = [...dayTotals.values()].reduce((a, t) => ({ kcal: a.kcal + t.kcal, p: a.p + t.p, c: a.c + t.c, f: a.f + t.f }), { kcal: 0, p: 0, c: 0, f: 0 });
        const targets = validateTargets(data ?? {});

        let organizationId = 0;
        try {
            const rows = await AppDataSource.query(`SELECT TOP 1 LatestOrgId FROM Users WHERE Id = @0`, [patientId]);
            organizationId = Number(rows?.[0]?.LatestOrgId) || 0;
        } catch {
            organizationId = 0;
        }

        const activate = data?.activate !== false;
        const plan = this.planRepo.create({
            PatientId: patientId,
            AssignedByDoctorId: patientId,
            CreatedByPatient: true,
            OrganizationId: organizationId,
            PlanName: planName,
            Description: optionalText(data?.description, "Description", 1000),
            Condition: optionalText(data?.condition, "Goal", 100),
            TotalDays: totalDays,
            StartDate: start,
            EndDate: end,
            DietType: dietType,
            DoctorNotes: optionalText(data?.notes, "Notes", 4000),
            TargetCalories: targets.targetCalories ?? Math.round(sum.kcal / days),
            TargetProteinG: targets.targetProteinG ?? Math.round((sum.p / days) * 10) / 10,
            TargetCarbsG: targets.targetCarbsG ?? Math.round((sum.c / days) * 10) / 10,
            TargetFatG: targets.targetFatG ?? Math.round((sum.f / days) * 10) / 10,
            Status: activate ? "active" : "paused",
        });

        const saved = await AppDataSource.transaction(async (manager) => {
            if (activate) {
                await manager.createQueryBuilder()
                    .update(PatientDietPlan)
                    .set({ Status: "paused", UpdatedAt: new Date() })
                    .where("PatientId = :patientId AND Status = 'active'", { patientId })
                    .execute();
            }
            const created = await manager.save(plan);
            await manager.save(this.toMealEntities(created.Id, meals));
            return created;
        });

        return await this.getPlanDetailsForPatient(saved.Id, patientId);
    }

    /** Deletes a plan the patient made themselves. Prescribed plans can't be deleted. */
    async deletePlanByPatient(planId: number, patientId: string) {
        const plan = await this.findPatientPlan(planId, patientId);
        if (!plan.CreatedByPatient) {
            throw new DietValidationError("Plans from your doctor can't be deleted. You can pause them instead.");
        }
        await this.planRepo.delete({ Id: planId });
        return { success: true, message: "Diet plan deleted." };
    }

    // --- Patient: meal tracking ---

    private toLogDto(log: PatientDietMealLog) {
        return {
            id: log.Id,
            planMealId: log.PlanMealId,
            logDate: dateOnly(log.LogDate as any),
            mealSlot: log.MealSlot,
            foodName: log.FoodName,
            isEaten: !!log.IsEaten,
            photoUrl: log.PhotoUrl ?? null,
            updatedAt: log.UpdatedAt ?? log.CreatedAt,
        };
    }

    /** The patient's meal records for a plan between two dates (at most 62 days). */
    async getMealLogs(planId: number, patientId: string, from: unknown, to: unknown) {
        await this.findPatientPlan(planId, patientId);
        const start = parseLogDate(from, "From date");
        const end = parseLogDate(to, "To date");
        if (end < start) throw new DietValidationError("To date cannot be before the from date.");
        if (utcDay(end) - utcDay(start) > 62) throw new DietValidationError("Ask for at most 62 days of meal records at a time.");

        const logs = await this.logRepo.createQueryBuilder("l")
            .where("l.PlanId = :planId AND l.LogDate BETWEEN :start AND :end", { planId, start, end })
            .getMany();
        return logs.map(log => this.toLogDto(log));
    }

    /**
     * Checks that the patient can record [planMealId] on [date]: their own
     * active plan, a date within the plan and not in the future, and a food
     * that is on the plan for that day.
     */
    async assertMealLoggable(planId: number, patientId: string, planMealId: unknown, date: unknown) {
        const plan = await this.findPatientPlan(planId, patientId);
        if (plan.Status !== "active") {
            throw new DietValidationError("Turn this plan on to track your meals.");
        }

        const logDate = parseLogDate(date);
        // The app sends the patient's local date, which can be a day ahead of UTC.
        if (utcDay(logDate) > utcDay(serverToday()) + 1) {
            throw new DietValidationError("You can't record meals for a future date.");
        }
        const start = dateOnly(plan.StartDate);
        const end = dateOnly(plan.EndDate);
        if ((start && logDate < start) || (end && logDate > end)) {
            throw new DietValidationError("That date is outside this plan's dates.");
        }

        const mealId = Number(planMealId);
        if (!Number.isInteger(mealId) || mealId <= 0) throw new DietValidationError("Choose a food to record.");
        const meal = await this.mealRepo.findOne({ where: { Id: mealId, PlanId: planId } });
        if (!meal) throw new DietValidationError("That food is no longer on your plan. Refresh and try again.");
        if (meal.DayNumber !== rotationDayFor(plan, logDate)) {
            throw new DietValidationError(`"${meal.FoodName}" isn't on your plan for that day.`);
        }

        return { plan, meal, logDate };
    }

    /** Records whether the patient ate a food on a date, and/or its photo. */
    async saveMealLog(planId: number, patientId: string, data: any, photoUrl?: string) {
        const { plan, meal, logDate } = await this.assertMealLoggable(planId, patientId, data?.planMealId, data?.date);

        const hasEaten = typeof data?.isEaten === "boolean";
        const removePhoto = data?.removePhoto === true;
        if (!hasEaten && !photoUrl && !removePhoto) {
            throw new DietValidationError("Nothing to save. Mark the food as eaten or add a photo.");
        }

        let log = await this.logRepo.findOne({ where: { PlanMealId: meal.Id, LogDate: logDate } });
        if (!log) {
            log = this.logRepo.create({
                PlanId: plan.Id,
                PlanMealId: meal.Id,
                PatientId: plan.PatientId,
                LogDate: logDate,
                IsEaten: false,
            });
        }
        log.MealSlot = meal.MealSlot;
        log.FoodName = meal.FoodName;
        if (hasEaten) log.IsEaten = data.isEaten;
        if (photoUrl) {
            log.PhotoUrl = photoUrl;
            // A photo of the meal means it was eaten, unless the app says otherwise.
            if (!hasEaten) log.IsEaten = true;
        } else if (removePhoto) {
            log.PhotoUrl = null;
        }
        log.UpdatedAt = new Date();

        const saved = await this.logRepo.save(log);
        return this.toLogDto(saved);
    }

}

export const patientDietPlanService = new PatientDietPlanService();
