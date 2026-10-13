import { AppDataSource } from "../../config/database.js";
import { PatientDietPlan } from "../../models/Diet/patient-diet-plan.model.js";
import { PatientDietPlanMeal } from "../../models/Diet/patient-diet-plan-meal.model.js";
import { DietTemplate } from "../../models/Diet/diet-template.model.js";
import { pushNotificationService } from "../Notifications/push-notification.service.js";

export class PatientDietPlanService {
    private planRepo = AppDataSource.getRepository(PatientDietPlan);
    private mealRepo = AppDataSource.getRepository(PatientDietPlanMeal);
    private templateRepo = AppDataSource.getRepository(DietTemplate);

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
            calories?: number;
            proteinG?: number;
            carbsG?: number;
            fatG?: number;
            notes?: string;
            sortOrder?: number;
        }>;
    }) {
        if (!data.organizationId) {
            throw new Error("OrganizationId is required to assign a diet plan.");
        }
        if (!data.patientId) {
            throw new Error("PatientId is required.");
        }
        if (!data.doctorId) {
            throw new Error("DoctorId is required.");
        }

        // Format foods avoid/prefer JSON
        const avoidJson = data.foodsToAvoid
            ? (typeof data.foodsToAvoid === "string" ? data.foodsToAvoid : JSON.stringify(data.foodsToAvoid))
            : null;
        const preferJson = data.foodsToPrefer
            ? (typeof data.foodsToPrefer === "string" ? data.foodsToPrefer : JSON.stringify(data.foodsToPrefer))
            : null;

        // Archive/complete previous active diet plans for this patient within the organization
        await this.planRepo.update(
            { PatientId: data.patientId, OrganizationId: data.organizationId, Status: "active" },
            { Status: "completed", UpdatedAt: new Date() }
        );

        const newPlan = this.planRepo.create({
            PatientId: data.patientId,
            AssignedByDoctorId: data.doctorId,
            OrganizationId: data.organizationId,
            HospitalId: data.hospitalId,
            AppointmentId: data.appointmentId,
            SourceTemplateId: data.sourceTemplateId,
            PlanName: data.planName,
            Description: data.description,
            Condition: data.condition,
            TotalDays: data.totalDays || 7,
            StartDate: data.startDate ? new Date(data.startDate) : new Date(),
            EndDate: data.endDate ? new Date(data.endDate) : undefined,
            TargetCalories: data.targetCalories,
            TargetProteinG: data.targetProteinG,
            TargetCarbsG: data.targetCarbsG,
            TargetFatG: data.targetFatG,
            DietType: data.dietType || "Veg",
            DoctorNotes: data.doctorNotes,
            FoodsToAvoid: avoidJson || undefined,
            FoodsToPrefer: preferJson || undefined,
            Status: "active"
        });

        const savedPlan = await this.planRepo.save(newPlan);

        // Meals to populate: either explicitly passed OR cloned from sourceTemplateId
        let mealsToInsert: any[] = [];

        if (data.meals && data.meals.length > 0) {
            mealsToInsert = data.meals;
        } else if (data.sourceTemplateId) {
            const template = await this.templateRepo.findOne({
                where: { Id: data.sourceTemplateId },
                relations: ["Meals"]
            });
            if (template?.Meals) {
                mealsToInsert = template.Meals.map(m => ({
                    dayNumber: m.DayNumber,
                    mealSlot: m.MealSlot,
                    mealTime: m.MealTime,
                    foodItemId: m.FoodItemId,
                    foodName: m.FoodName,
                    quantity: m.Quantity,
                    unit: m.Unit,
                    calories: m.Calories,
                    proteinG: m.ProteinG,
                    carbsG: m.CarbsG,
                    fatG: m.FatG,
                    notes: m.Notes,
                    sortOrder: m.SortOrder
                }));
            }
        }

        if (mealsToInsert.length > 0) {
            const mealEntities = mealsToInsert.map((m, index) => this.mealRepo.create({
                PlanId: savedPlan.Id,
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

        // Notify patient on mobile via Push Notification
        try {
            const doctorUser = await AppDataSource.query(`SELECT Name FROM Users WHERE Id = @0`, [data.doctorId]);
            const doctorName = doctorUser[0]?.Name ? `Dr. ${doctorUser[0].Name}` : "Your Doctor";

            await pushNotificationService.sendNotification({
                userId: data.patientId,
                senderId: data.doctorId,
                title: "🥗 New Diet Plan Prescribed",
                body: `${doctorName} has assigned your personalized diet plan: "${data.planName}". Tap to view your daily meal schedule.`,
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
     * Get all diet plans for a patient within an organization
     */
    async getPatientPlans(patientId: string, organizationId?: number) {
        const qb = this.planRepo.createQueryBuilder("p")
            .leftJoinAndSelect("p.AssignedByDoctor", "doctor")
            .leftJoinAndSelect("p.Organization", "org")
            .leftJoinAndSelect("p.Hospital", "hospital")
            .where("p.PatientId = :patientId", { patientId });

        if (organizationId) {
            qb.andWhere("p.OrganizationId = :orgId", { orgId: organizationId });
        }

        qb.orderBy("p.CreatedAt", "DESC");

        return await qb.getMany();
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

        return await qb.getOne();
    }

    /**
     * Update an assigned diet plan
     */
    async updatePlan(planId: number, data: any, organizationId: number) {
        const existing = await this.planRepo.findOne({ where: { Id: planId } });
        if (!existing) {
            throw new Error("Diet plan not found.");
        }

        if (existing.OrganizationId !== organizationId) {
            throw new Error("Access denied: You cannot modify a diet plan belonging to another organization.");
        }

        existing.PlanName = data.planName ?? existing.PlanName;
        existing.Description = data.description ?? existing.Description;
        existing.Condition = data.condition ?? existing.Condition;
        existing.TotalDays = data.totalDays ?? existing.TotalDays;
        existing.StartDate = data.startDate ? new Date(data.startDate) : existing.StartDate;
        existing.EndDate = data.endDate ? new Date(data.endDate) : existing.EndDate;
        existing.TargetCalories = data.targetCalories ?? existing.TargetCalories;
        existing.TargetProteinG = data.targetProteinG ?? existing.TargetProteinG;
        existing.TargetCarbsG = data.targetCarbsG ?? existing.TargetCarbsG;
        existing.TargetFatG = data.targetFatG ?? existing.TargetFatG;
        existing.DietType = data.dietType ?? existing.DietType;
        existing.DoctorNotes = data.doctorNotes ?? existing.DoctorNotes;
        if (data.foodsToAvoid !== undefined) {
            existing.FoodsToAvoid = typeof data.foodsToAvoid === "string" ? data.foodsToAvoid : JSON.stringify(data.foodsToAvoid);
        }
        if (data.foodsToPrefer !== undefined) {
            existing.FoodsToPrefer = typeof data.foodsToPrefer === "string" ? data.foodsToPrefer : JSON.stringify(data.foodsToPrefer);
        }
        existing.UpdatedAt = new Date();

        await this.planRepo.save(existing);

        if (data.meals && Array.isArray(data.meals)) {
            await this.mealRepo.delete({ PlanId: planId });

            const mealEntities = data.meals.map((m: any, index: number) => this.mealRepo.create({
                PlanId: planId,
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

        return await this.getPlanDetails(planId, organizationId);
    }

    /**
     * Change plan status: active | completed | paused | cancelled
     */
    async updatePlanStatus(planId: number, status: string, organizationId: number) {
        const existing = await this.planRepo.findOne({ where: { Id: planId } });
        if (!existing) {
            throw new Error("Diet plan not found.");
        }

        if (existing.OrganizationId !== organizationId) {
            throw new Error("Access denied: You cannot modify a diet plan belonging to another organization.");
        }

        existing.Status = status;
        existing.UpdatedAt = new Date();
        await this.planRepo.save(existing);

        return { success: true, message: `Diet plan status updated to ${status}.` };
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
            ...plan,
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
                doctorName: (activePlan as any).AssignedByDoctor?.Name || "Doctor",
                organizationName: (activePlan as any).Organization?.Name || "Clinic",
                hospitalName: (activePlan as any).Hospital?.Name || null,
                condition: activePlan.Condition,
                dietType: activePlan.DietType,
                doctorNotes: activePlan.DoctorNotes,
                foodsToAvoid: activePlan.FoodsToAvoid ? JSON.parse(activePlan.FoodsToAvoid) : [],
                foodsToPrefer: activePlan.FoodsToPrefer ? JSON.parse(activePlan.FoodsToPrefer) : [],
                targetCalories: activePlan.TargetCalories,
                targetProteinG: activePlan.TargetProteinG,
                targetCarbsG: activePlan.TargetCarbsG,
                targetFatG: activePlan.TargetFatG,
                totalDays: activePlan.TotalDays,
                currentDayNumber: currentDay,
                startDate: activePlan.StartDate,
                endDate: activePlan.EndDate
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
}

export const patientDietPlanService = new PatientDietPlanService();
