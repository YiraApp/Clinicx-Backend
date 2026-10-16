export class DietValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DietValidationError";
    }
}

export const MAX_ROTATION_DAYS = 30;
export const MAX_MEALS_PER_PLAN = 600;
const PLAN_STATUSES = ["active", "completed", "paused", "cancelled"];

export interface DietMealPayload {
    dayNumber?: number;
    mealSlot: string;
    mealTime: string;
    foodItemId?: number | null;
    foodName: string;
    quantity: number;
    unit?: string;
    weightAmount?: number | null;
    weightUnit?: string | null;
    calories?: number;
    proteinG?: number | null;
    carbsG?: number | null;
    fatG?: number | null;
    notes?: string | null;
    sortOrder?: number;
}

function fail(message: string): never {
    throw new DietValidationError(message);
}

function optionalNumber(value: unknown, label: string, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    const n = Number(value);
    if (!Number.isFinite(n)) fail(`${label} must be a number.`);
    if (n < min || n > max) fail(`${label} must be between ${min} and ${max}.`);
    return n;
}

export function requireText(value: unknown, label: string, maxLength: number): string {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) fail(`${label} is required.`);
    if (text.length > maxLength) fail(`${label} must be ${maxLength} characters or fewer.`);
    return text;
}

export function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    if (text.length > maxLength) fail(`${label} must be ${maxLength} characters or fewer.`);
    return text || undefined;
}

export function validateTotalDays(value: unknown, fallback = 1): number {
    const days = optionalNumber(value, "Number of rotation days", { min: 1, max: MAX_ROTATION_DAYS });
    if (days !== undefined && !Number.isInteger(days)) fail("Number of rotation days must be a whole number.");
    return days ?? fallback;
}

export function validateTargets(data: any) {
    return {
        targetCalories: optionalNumber(data.targetCalories, "Target calories", { max: 10000 }),
        targetProteinG: optionalNumber(data.targetProteinG, "Target protein", { max: 1000 }),
        targetCarbsG: optionalNumber(data.targetCarbsG, "Target carbs", { max: 2000 }),
        targetFatG: optionalNumber(data.targetFatG, "Target fat", { max: 1000 }),
    };
}

export function validatePlanStatus(status: unknown): string {
    const value = typeof status === "string" ? status.trim().toLowerCase() : "";
    if (!PLAN_STATUSES.includes(value)) fail(`Status must be one of: ${PLAN_STATUSES.join(", ")}.`);
    return value;
}

export function validateDateRange(startDate: unknown, endDate: unknown): { start?: Date; end?: Date } {
    const parse = (value: unknown, label: string) => {
        if (value === undefined || value === null || value === "") return undefined;
        const d = new Date(String(value));
        if (Number.isNaN(d.getTime())) fail(`${label} is not a valid date.`);
        return d;
    };
    const start = parse(startDate, "Start date");
    const end = parse(endDate, "End date");
    if (start && end && end.getTime() < start.getTime()) fail("End date cannot be before the start date.");
    return { start, end };
}

/**
 * Energy from protein, carbs and fat (4, 4 and 9 kcal per gram), used when a
 * food has no calorie value of its own. 0 when the macros are unknown too.
 */
export function caloriesFromMacros(proteinG?: number, carbsG?: number, fatG?: number): number {
    return Math.round((proteinG ?? 0) * 4 + (carbsG ?? 0) * 4 + (fatG ?? 0) * 9);
}

/**
 * Checks every meal and returns a cleaned copy. Each error names the day and
 * slot so the person editing can find the item.
 */
export function validateMeals(meals: unknown, totalDays: number, { requireAtLeastOne = false } = {}): DietMealPayload[] {
    if (meals === undefined || meals === null) {
        if (requireAtLeastOne) fail("Add at least one food item to the plan.");
        return [];
    }
    if (!Array.isArray(meals)) fail("Meals must be a list.");
    if (requireAtLeastOne && meals.length === 0) fail("Add at least one food item to the plan.");
    if (meals.length > MAX_MEALS_PER_PLAN) fail(`A plan can have at most ${MAX_MEALS_PER_PLAN} food items.`);

    return meals.map((raw: any, index: number) => {
        if (!raw || typeof raw !== "object") fail(`Food item ${index + 1} is invalid.`);

        const dayNumber = raw.dayNumber === undefined || raw.dayNumber === null ? 1 : Number(raw.dayNumber);
        if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > totalDays) {
            fail(`Food item ${index + 1} is on day ${raw.dayNumber}, but the plan only has ${totalDays} day(s).`);
        }

        const where = `Day ${dayNumber}`;
        const mealSlot = requireText(raw.mealSlot, `${where}: meal slot`, 50);
        const at = `${where}, ${mealSlot}`;
        const foodName = requireText(raw.foodName, `${at}: food name`, 200);
        const mealTime = requireText(raw.mealTime, `${at}: meal time for "${foodName}"`, 20);

        const quantity = Number(raw.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 999) {
            fail(`${at}: quantity for "${foodName}" must be greater than 0.`);
        }

        const weightAmount = optionalNumber(raw.weightAmount, `${at}: weight for "${foodName}"`, { max: 10000 });
        const weightUnitRaw = optionalText(raw.weightUnit, `${at}: weight unit`, 10);
        if (weightUnitRaw && !["g", "ml"].includes(weightUnitRaw.toLowerCase())) {
            fail(`${at}: weight unit for "${foodName}" must be g or ml.`);
        }

        const foodItemId = raw.foodItemId === undefined || raw.foodItemId === null || raw.foodItemId === ""
            ? undefined
            : Number(raw.foodItemId);
        if (foodItemId !== undefined && (!Number.isInteger(foodItemId) || foodItemId <= 0)) {
            fail(`${at}: "${foodName}" refers to an invalid food item.`);
        }

        const proteinG = optionalNumber(raw.proteinG, `${at}: protein for "${foodName}"`, { max: 1000 });
        const carbsG = optionalNumber(raw.carbsG, `${at}: carbs for "${foodName}"`, { max: 1000 });
        const fatG = optionalNumber(raw.fatG, `${at}: fat for "${foodName}"`, { max: 1000 });
        const statedCalories = optionalNumber(raw.calories, `${at}: calories for "${foodName}"`, { max: 10000 }) ?? 0;

        return {
            dayNumber,
            mealSlot,
            mealTime,
            foodItemId,
            foodName,
            quantity,
            unit: optionalText(raw.unit, `${at}: unit for "${foodName}"`, 50) || "serving",
            weightAmount: weightAmount || undefined,
            weightUnit: weightAmount ? (weightUnitRaw?.toLowerCase() || "g") : undefined,
            calories: statedCalories > 0 ? statedCalories : caloriesFromMacros(proteinG, carbsG, fatG),
            proteinG,
            carbsG,
            fatG,
            notes: optionalText(raw.notes, `${at}: note for "${foodName}"`, 500),
            sortOrder: Number.isInteger(raw.sortOrder) ? raw.sortOrder : index,
        };
    });
}
