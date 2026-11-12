/**
 * Checks on what a phone sends to the fitness sync. Pure functions with no
 * database access, so they can be checked on their own.
 */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The earliest day a synced reading can be for (HealthKit launched in 2014). */
export const EARLIEST_FITNESS_DATE = "2014-01-01";

/** Hourly chart data is 24 small entries; anything far bigger is not hourly data. */
export const MAX_HOURLY_JSON_LENGTH = 16_000;
export const MAX_METRICS_JSON_LENGTH = 4_000;

/** A real calendar date written as YYYY-MM-DD. Rejects dates like 2026-02-30. */
export function isCalendarDate(key: unknown): key is string {
    if (typeof key !== "string" || !DATE_RE.test(key)) return false;
    const d = new Date(`${key}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === key;
}

/** Today's date on the server's own clock (Asia/Kolkata), not UTC. */
export function localDateKey(d: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(dateKey: string, days: number): string {
    const d = new Date(`${dateKey}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split("T")[0];
}

/**
 * Whether a phone may save readings for [dateKey]: a real date, not before
 * HealthKit existed, and not after tomorrow (a phone in a timezone ahead of
 * India can already be on the next day). A wrong phone clock otherwise leaves
 * rows dated years ahead.
 */
export function isSyncableDate(dateKey: unknown, today: string = localDateKey()): dateKey is string {
    return isCalendarDate(dateKey) && dateKey >= EARLIEST_FITNESS_DATE && dateKey <= addDays(today, 1);
}

/**
 * JSON text for a stored blob, or null when it is missing, unreadable, not
 * the expected shape, or longer than [maxLength].
 */
export function boundedJson(raw: unknown, maxLength: number, { array = false } = {}): string | null {
    if (raw === undefined || raw === null || raw === "") return null;
    let value: unknown = raw;
    if (typeof raw === "string") {
        try {
            value = JSON.parse(raw);
        } catch {
            return null;
        }
    }
    if (value === null || typeof value !== "object") return null;
    if (array && (!Array.isArray(value) || value.length === 0)) return null;
    const text = JSON.stringify(value);
    return text.length <= maxLength ? text : null;
}

/** SQL Server's duplicate key errors (unique constraint 2627, unique index 2601). */
export function isDuplicateKeyError(error: any): boolean {
    const code = Number(error?.number ?? error?.driverError?.number ?? error?.originalError?.info?.number);
    return code === 2627 || code === 2601;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** User ids are SQL uniqueidentifiers; anything else would fail inside the query. */
export const isGuid = (v: unknown): v is string => typeof v === "string" && GUID_RE.test(v.trim());
