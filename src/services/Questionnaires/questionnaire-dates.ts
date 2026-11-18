/**
 * A DATE column as "YYYY-MM-DD". The driver (useUTC: false) hands a DATE back as midnight in the
 * server's time zone, India, so toISOString() would give the day before (18:30 UTC). Read the
 * local calendar date instead. Strings are passed through as their first 10 characters.
 */
export function dateOnly(value: unknown): string | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "string") return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
    const d = value instanceof Date ? value : new Date(value as any);
    if (Number.isNaN(d.getTime())) return null;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
