/**
 * Filters and date buckets for the CEO dashboard (Yira System Admin). Pure functions only, so the
 * query-string rules can be tested without a database.
 */

export type Granularity = "day" | "week" | "month";
export const GRANULARITIES: readonly Granularity[] = ["day", "week", "month"];

export const GENDERS = ["Male", "Female", "Other", "Unknown"] as const;
export type Gender = (typeof GENDERS)[number];

export const AGE_BANDS = ["0-17", "18-29", "30-44", "45-59", "60+", "Unknown"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export interface CeoDashboardFilters {
    /** First day of the period, inclusive (YYYY-MM-DD, India time). */
    from: string;
    /** Last day of the period, inclusive. */
    to: string;
    granularity: Granularity;
    roleIds: string[];
    organizationId: number | null;
    hospitalId: number | null;
    gender: Gender | null;
    ageBand: AgeBand | null;
    /** Location filters match the hospital's address. */
    state: string | null;
    city: string | null;
    pincode: string | null;
    /** Narrows Provider rows to providers of this specialty. */
    specialty: string | null;
    /** Narrows Patient rows to patients with a matching recorded diagnosis (text or SNOMED concept id). */
    disease: string | null;
}

export interface DashboardRange {
    from: string;
    to: string;
    /** The equal-length period just before `from`, for comparisons. */
    previousFrom: string;
    previousTo: string;
    granularity: Granularity;
    buckets: string[];
}

export class FilterError extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
/** Ten years: longer ranges are a typo, and month buckets past that are unreadable anyway. */
const MAX_RANGE_DAYS = 3660;

const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);

export const addDays = (iso: string, days: number): string => toIso(new Date(toDate(iso).getTime() + days * DAY_MS));
export const daysBetween = (from: string, to: string): number => Math.round((toDate(to).getTime() - toDate(from).getTime()) / DAY_MS);

/** Today's date in India (the dashboard's reporting time zone). */
export const todayInIndia = (now: Date = new Date()): string => toIso(new Date(now.getTime() + 330 * 60_000));

const isRealDate = (iso: string) => ISO_DATE.test(iso) && toIso(toDate(iso)) === iso;

/** Start of the bucket holding `iso`: the day, the Monday of its week, or the 1st of its month. */
export function bucketStart(iso: string, granularity: Granularity): string {
    if (granularity === "day") return iso;
    if (granularity === "month") return `${iso.slice(0, 7)}-01`;
    const mondayOffset = (toDate(iso).getUTCDay() + 6) % 7;
    return addDays(iso, -mondayOffset);
}

/** Every bucket start from the one holding `from` through the one holding `to`. */
export function bucketsBetween(from: string, to: string, granularity: Granularity): string[] {
    const buckets: string[] = [];
    let current = bucketStart(from, granularity);
    while (current <= to) {
        buckets.push(current);
        if (granularity === "day") current = addDays(current, 1);
        else if (granularity === "week") current = addDays(current, 7);
        else {
            const d = toDate(current);
            current = toIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
        }
    }
    return buckets;
}

/** The natural bucket size for a range, used when none is asked for. */
export function defaultGranularity(from: string, to: string): Granularity {
    const days = daysBetween(from, to) + 1;
    if (days <= 31) return "day";
    if (days <= 186) return "week";
    return "month";
}

/** Steps up from day or week buckets when there would be too many to read. */
export function effectiveGranularity(from: string, to: string, requested: Granularity): Granularity {
    const days = daysBetween(from, to) + 1;
    let granularity = requested;
    if (granularity === "day" && days > 186) granularity = "week";
    if (granularity === "week" && days > 1100) granularity = "month";
    return granularity;
}

export function dashboardRange(filters: Pick<CeoDashboardFilters, "from" | "to" | "granularity">): DashboardRange {
    const length = daysBetween(filters.from, filters.to) + 1;
    return {
        from: filters.from,
        to: filters.to,
        previousFrom: addDays(filters.from, -length),
        previousTo: addDays(filters.from, -1),
        granularity: filters.granularity,
        buckets: bucketsBetween(filters.from, filters.to, filters.granularity),
    };
}

type QueryValue = unknown;

const first = (value: QueryValue): string | undefined => {
    if (Array.isArray(value)) return first(value[0]);
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    return undefined;
};

const text = (value: QueryValue, name: string, maxLength = 100): string | null => {
    const raw = first(value)?.trim();
    if (!raw) return null;
    if (raw.length > maxLength) throw new FilterError(`${name} is too long.`);
    return raw;
};

const positiveInt = (value: QueryValue, name: string): number | null => {
    const raw = first(value)?.trim();
    if (!raw || raw === "all") return null;
    if (!/^\d+$/.test(raw) || Number(raw) <= 0 || Number(raw) > 2_147_483_647) throw new FilterError(`${name} must be a positive number.`);
    return Number(raw);
};

const oneOf = <T extends string>(value: QueryValue, allowed: readonly T[], name: string): T | null => {
    const raw = first(value)?.trim();
    if (!raw || raw === "all") return null;
    const match = allowed.find((option) => option.toLowerCase() === raw.toLowerCase());
    if (!match) throw new FilterError(`${name} must be one of: ${allowed.join(", ")}.`);
    return match;
};

const roleIdList = (value: QueryValue): string[] => {
    const parts = (Array.isArray(value) ? value : [value])
        .flatMap((v) => (first(v) ?? "").split(","))
        .map((v) => v.trim())
        .filter(Boolean);
    if (parts.length > 20) throw new FilterError("Too many roles.");
    for (const id of parts) {
        if (!GUID.test(id)) throw new FilterError("roleIds must be role ids.");
    }
    return Array.from(new Set(parts.map((id) => id.toUpperCase())));
};

/** Reads and checks the dashboard's query string. Throws FilterError with a message for the user. */
export function parseCeoDashboardQuery(query: Record<string, QueryValue>, today: string = todayInIndia()): CeoDashboardFilters {
    const to = text(query.to, "to") ?? today;
    const from = text(query.from, "from") ?? addDays(to, -29);
    if (!isRealDate(from) || !isRealDate(to)) throw new FilterError("from and to must be dates (YYYY-MM-DD).");
    if (from > to) throw new FilterError("from must be on or before to.");
    if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw new FilterError("The date range can be at most ten years.");

    const requested = oneOf(query.granularity, GRANULARITIES, "granularity") ?? defaultGranularity(from, to);

    return {
        from,
        to,
        granularity: effectiveGranularity(from, to, requested),
        roleIds: roleIdList(query.roleIds),
        organizationId: positiveInt(query.organizationId, "organizationId"),
        hospitalId: positiveInt(query.hospitalId, "hospitalId"),
        gender: oneOf(query.gender, GENDERS, "gender"),
        ageBand: oneOf(query.ageBand, AGE_BANDS, "ageBand"),
        state: text(query.state, "state"),
        city: text(query.city, "city"),
        pincode: text(query.pincode, "pincode", 10),
        specialty: text(query.specialty, "specialty"),
        disease: text(query.disease, "disease"),
    };
}

/** A LIKE pattern that matches `term` anywhere, with LIKE's wildcards escaped (use ESCAPE '\'). */
export const containsPattern = (term: string): string => `%${term.replace(/[\\%_[]/g, (c) => `\\${c}`)}%`;

/** "PaymentPending" → "Payment pending", "in-progress" → "In progress". */
export function statusLabel(status: string | null | undefined): string {
    const spaced = (status ?? "").trim().replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").toLowerCase();
    return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "Unknown";
}
