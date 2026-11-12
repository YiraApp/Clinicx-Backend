import { AppDataSource } from "../../config/database.js";

/**
 * "Ask AI" in the diet food picker: fills in calories and macros for a food and amount when the
 * doctor (or patient) doesn't know them. The app's own food database answers first, scaled to the
 * amount; Gemini estimates the rest. Either way the app shows where the numbers came from.
 */

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export class FoodAiError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
    }
}

export interface FoodQuestion {
    name: string;
    quantity: number;
    unit: string;
    grams: number | null;
    foodType: string | null;
    slot: string | null;
    dietType: string | null;
}

export interface FoodAnswer {
    source: "database" | "ai";
    /** The database food used, when it came from there */
    matchedName: string | null;
    grams: number | null;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    fiber: number | null;
    confidence: "high" | "medium" | "low";
    /** A short instruction the doctor may give the patient with this food */
    instruction: string | null;
    note: string | null;
}

const clean = (v: unknown, max = 120) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
};
const round1 = (n: number) => Math.round(n * 10) / 10;
const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** "2 pieces (80g)" → { count: 2, grams: 80 }; "1 katori (150ml)" → { count: 1, grams: 150 } */
export function parseServing(serving?: string | null): { count: number | null; grams: number | null } {
    const s = String(serving || "");
    const grams = s.match(/(\d+(?:\.\d+)?)\s*(g|gm|grams?|ml)\b/i);
    const count = s.match(/^\s*(\d+(?:\.\d+)?)/);
    return { count: count ? Number(count[1]) : null, grams: grams ? Number(grams[1]) : null };
}

/** How many servings of a database food the asked amount is. */
export function servingFactor(q: Pick<FoodQuestion, "quantity" | "unit" | "grams">, serving: { count: number | null; grams: number | null }): { factor: number; grams: number | null } {
    if (q.grams && serving.grams) return { factor: q.grams / serving.grams, grams: q.grams };
    const unit = q.unit.toLowerCase();
    const isWeight = /^(g|gm|grams?|ml)$/.test(unit);
    if (isWeight && q.quantity > 0 && serving.grams) return { factor: q.quantity / serving.grams, grams: q.quantity };
    const perServing = serving.count && serving.count > 0 ? serving.count : 1;
    const factor = q.quantity > 0 ? q.quantity / perServing : 1;
    return { factor, grams: serving.grams ? round1(serving.grams * factor) : null };
}

class FoodAiService {
    private get apiKey() {
        return (process.env.GEMINI_API_KEY || "").trim();
    }

    private get model() {
        return (process.env.GEMINI_MODEL || "gemini-3.8-flash").trim();
    }

    get aiConfigured() {
        return this.apiKey.length > 0;
    }

    parse(body: any): FoodQuestion {
        const name = clean(body?.name);
        if (name.length < 2) throw new FoodAiError("Type the food's name first.");
        const quantity = num(body?.quantity) ?? 1;
        const grams = num(body?.grams);
        return {
            name,
            quantity: quantity > 0 ? Math.min(quantity, 5000) : 1,
            unit: clean(body?.unit, 30) || "serving",
            grams: grams && grams > 0 ? Math.min(grams, 5000) : null,
            foodType: clean(body?.foodType, 20) || null,
            slot: clean(body?.slot, 40) || null,
            dietType: clean(body?.dietType, 20) || null,
        };
    }

    async ask(q: FoodQuestion): Promise<FoodAnswer> {
        const fromDb = await this.fromDatabase(q);
        if (fromDb) return fromDb;
        if (!this.aiConfigured) {
            throw new FoodAiError(
                `"${q.name}" isn't in the food list, and AI isn't set up on this server yet (GEMINI_API_KEY is missing). Pick a food from the list or enter the values.`,
                503
            );
        }
        return this.fromAi(q);
    }

    /** A close name match in the food list (global or the organisation's), scaled to the amount. */
    private async fromDatabase(q: FoodQuestion): Promise<FoodAnswer | null> {
        const wanted = norm(q.name);
        if (!wanted) return null;
        const words = wanted.split(" ").filter((w) => w.length >= 3).slice(0, 3);
        if (!words.length) return null;
        const params = words.map((w) => `%${w}%`);
        const rows: any[] = await AppDataSource.query(
            `SELECT TOP 40 Name, ServingSize, CaloriesPerServing, ProteinG, CarbsG, FatG, FiberG
             FROM DietFoodItems WHERE IsActive = 1 AND (${words.map((_, i) => `Name LIKE @${i}`).join(" OR ")})`,
            params
        );
        // Exact name first; otherwise one name containing the other with most of its words
        let best: any = null;
        let bestScore = 0;
        for (const r of rows) {
            const n = norm(String(r.Name));
            let score = 0;
            if (n === wanted) score = 1;
            else if (n.includes(wanted) || wanted.includes(n)) score = Math.min(n.length, wanted.length) / Math.max(n.length, wanted.length);
            if (score > bestScore) {
                best = r;
                bestScore = score;
            }
        }
        if (!best || bestScore < 0.6) return null;

        const { factor, grams } = servingFactor(q, parseServing(best.ServingSize));
        const f = (v: unknown) => round1((Number(v) || 0) * factor);
        return {
            source: "database",
            matchedName: String(best.Name),
            grams,
            calories: Math.round((Number(best.CaloriesPerServing) || 0) * factor),
            protein: f(best.ProteinG),
            carbs: f(best.CarbsG),
            fat: f(best.FatG),
            fiber: best.FiberG == null ? null : f(best.FiberG),
            confidence: bestScore === 1 ? "high" : "medium",
            instruction: null,
            note: `From the food list: ${best.Name}${best.ServingSize ? ` (${best.ServingSize} per serving)` : ""}.`,
        };
    }

    private async fromAi(q: FoodQuestion): Promise<FoodAnswer> {
        const amount = `${q.quantity} ${q.unit}${q.grams ? ` (about ${q.grams} g)` : ""}`;
        const prompt = [
            "You are a clinical nutrition assistant for Indian hospitals. Estimate the nutrition of one food portion.",
            "Use Indian Food Composition Tables (IFCT 2017) values where they exist, home-style preparation unless the name says otherwise.",
            `Food: ${q.name}`,
            `Amount: ${amount}`,
            q.foodType ? `Food type: ${q.foodType}` : "",
            q.slot ? `Meal: ${q.slot}` : "",
            "Reply with JSON only: {\"grams\": number (total weight of this amount), \"calories\": number (kcal), \"protein\": number (g), \"carbs\": number (g), \"fat\": number (g), \"fiber\": number (g),",
            "\"confidence\": \"high\"|\"medium\"|\"low\", \"instruction\": a short instruction for the patient about eating this food (max 15 words, e.g. how to cook it or what to avoid), \"note\": the assumption you made about the portion or recipe (max 20 words)}.",
            "If the food is not real or not edible, return calories 0 and confidence \"low\" with a note saying so.",
        ].filter(Boolean).join("\n");

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        let response: Response;
        try {
            response = await fetch(`${GEMINI_URL}/${this.model}:generateContent`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
                signal: controller.signal,
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.1, maxOutputTokens: 512, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
                }),
            });
        } catch (err: any) {
            throw new FoodAiError(err?.name === "AbortError" ? "AI took too long. Please try again." : "Could not reach the AI service.", 502);
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            console.error(`[FoodAI] Gemini ${response.status}: ${body.slice(0, 300)}`);
            throw new FoodAiError(response.status === 429 ? "AI is busy. Try again in a minute." : "The AI service returned an error.", 502);
        }
        const json: any = await response.json();
        const text = (json?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("").trim();
        let raw: any;
        try {
            raw = JSON.parse(text.replace(/^```\w*\s*/, "").replace(/\s*```$/, ""));
        } catch {
            console.error("[FoodAI] Unparseable reply:", text.slice(0, 200));
            throw new FoodAiError("The AI reply couldn't be read. Please try again.", 502);
        }
        const v = (x: unknown, max: number) => {
            const n = num(x);
            return n == null ? 0 : round1(Math.min(n, max));
        };
        const calories = Math.round(v(raw?.calories, 5000));
        if (calories <= 0 && String(raw?.confidence) === "low") {
            throw new FoodAiError(clean(raw?.note, 200) || `AI couldn't estimate "${q.name}". Check the name or enter the values.`, 422);
        }
        const confidence = ["high", "medium", "low"].includes(String(raw?.confidence)) ? raw.confidence : "medium";
        return {
            source: "ai",
            matchedName: null,
            grams: num(raw?.grams) ? round1(Math.min(Number(raw.grams), 5000)) : q.grams,
            calories,
            protein: v(raw?.protein, 500),
            carbs: v(raw?.carbs, 1000),
            fat: v(raw?.fat, 500),
            fiber: raw?.fiber == null ? null : v(raw?.fiber, 200),
            confidence,
            instruction: clean(raw?.instruction, 140) || null,
            note: clean(raw?.note, 160) || null,
        };
    }
}

export const foodAiService = new FoodAiService();
