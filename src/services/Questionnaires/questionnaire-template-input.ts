// Checks a doctor's own questionnaire (a "template") before it is saved. No database here, so it can
// be tested on its own; the service turns a problem into a QuestionnaireError.

export const TEMPLATE_TYPE_CODES = [
    "SHORT_TEXT",
    "LONG_TEXT",
    "NUMBER",
    "SINGLE_CHOICE",
    "MULTI_CHOICE",
    "DROPDOWN",
    "YES_NO",
    "DATE",
    "RATING",
] as const;
export type TemplateTypeCode = (typeof TEMPLATE_TYPE_CODES)[number];

const OPTION_TYPES: readonly string[] = ["SINGLE_CHOICE", "MULTI_CHOICE", "DROPDOWN"];

export interface TemplateQuestionInput {
    text?: unknown;
    typeCode?: unknown;
    helpText?: unknown;
    isRequired?: unknown;
    options?: unknown;
    minValue?: unknown;
    maxValue?: unknown;
}

export interface TemplateInput {
    title?: unknown;
    description?: unknown;
    allowMultiple?: unknown;
    questions?: unknown;
}

export interface CleanTemplateQuestion {
    text: string;
    typeCode: TemplateTypeCode;
    helpText: string | null;
    isRequired: boolean;
    options: string[];
    minValue: number | null;
    maxValue: number | null;
}

export interface CleanTemplate {
    title: string;
    description: string | null;
    allowMultiple: boolean;
    /** Left out when the input had no questions list (an update of the wording only). */
    questions?: CleanTemplateQuestion[];
}

export const TEMPLATE_LIMITS = { title: 200, description: 2000, question: 1000, helpText: 1000, option: 500, options: 50, questions: 100 };

type Result = { ok: true; value: CleanTemplate } | { ok: false; error: string };

const str = (value: unknown) => (value === undefined || value === null ? "" : String(value).trim());
const flag = (value: unknown, fallback: boolean) =>
    value === undefined || value === null ? fallback : value === true || value === 1 || value === "true" || value === "1";

function num(value: unknown): number | null | "bad" {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : "bad";
}

/**
 * The template as it will be saved, or the first problem in words a doctor understands.
 * With [requireQuestions] false a missing questions list is allowed (renaming only).
 */
export function cleanTemplate(input: TemplateInput | null | undefined, requireQuestions = true): Result {
    const fail = (error: string): Result => ({ ok: false, error });
    const title = str(input?.title);
    if (!title) return fail("Give the questionnaire a name.");
    if (title.length > TEMPLATE_LIMITS.title) return fail(`The name must be ${TEMPLATE_LIMITS.title} characters or fewer.`);
    const description = str(input?.description) || null;
    if (description && description.length > TEMPLATE_LIMITS.description) return fail(`The description must be ${TEMPLATE_LIMITS.description} characters or fewer.`);
    const allowMultiple = flag(input?.allowMultiple, true);

    if (input?.questions === undefined && !requireQuestions) return { ok: true, value: { title, description, allowMultiple } };
    if (!Array.isArray(input?.questions) || input.questions.length === 0) return fail("Add at least one question.");
    if (input.questions.length > TEMPLATE_LIMITS.questions) return fail(`A questionnaire can have up to ${TEMPLATE_LIMITS.questions} questions.`);

    const questions: CleanTemplateQuestion[] = [];
    for (const [n, raw] of (input.questions as TemplateQuestionInput[]).entries()) {
        const where = `Question ${n + 1}`;
        const text = str(raw?.text);
        if (!text) return fail(`${where} has no text.`);
        if (text.length > TEMPLATE_LIMITS.question) return fail(`${where} must be ${TEMPLATE_LIMITS.question} characters or fewer.`);
        const typeCode = str(raw?.typeCode).toUpperCase() as TemplateTypeCode;
        if (!TEMPLATE_TYPE_CODES.includes(typeCode)) return fail(`${where}: choose how it is answered.`);
        const helpText = str(raw?.helpText) || null;
        if (helpText && helpText.length > TEMPLATE_LIMITS.helpText) return fail(`${where}: the hint must be ${TEMPLATE_LIMITS.helpText} characters or fewer.`);

        let options: string[] = [];
        if (OPTION_TYPES.includes(typeCode)) {
            options = (Array.isArray(raw?.options) ? raw.options : []).map(str).filter(Boolean);
            if (options.length < 2) return fail(`${where} needs at least two options.`);
            if (options.length > TEMPLATE_LIMITS.options) return fail(`${where} can have up to ${TEMPLATE_LIMITS.options} options.`);
            const seen = new Set<string>();
            for (const option of options) {
                if (option.length > TEMPLATE_LIMITS.option) return fail(`${where}: options must be ${TEMPLATE_LIMITS.option} characters or fewer.`);
                const key = option.toLowerCase();
                if (seen.has(key)) return fail(`${where}: "${option}" is listed twice.`);
                seen.add(key);
            }
        }

        let minValue: number | null = null;
        let maxValue: number | null = null;
        if (typeCode === "RATING") {
            minValue = 1;
            maxValue = 5;
        } else if (typeCode === "NUMBER") {
            const min = num(raw?.minValue);
            const max = num(raw?.maxValue);
            if (min === "bad" || max === "bad") return fail(`${where}: the lowest and highest allowed values must be numbers.`);
            if (min != null && max != null && min > max) return fail(`${where}: the lowest value can't be more than the highest.`);
            minValue = min;
            maxValue = max;
        }

        questions.push({ text, typeCode, helpText, isRequired: flag(raw?.isRequired, false), options, minValue, maxValue });
    }
    return { ok: true, value: { title, description, allowMultiple, questions } };
}
