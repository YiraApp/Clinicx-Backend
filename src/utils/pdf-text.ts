// The built-in PDF fonts (Helvetica) only cover Latin-1 and a few extra characters (WinAnsi).
// Anything else, such as Telugu or Hindi script or emoji, prints as junk, so it is left out,
// and the rupee sign is written as "Rs.".
const WIN_ANSI_EXTRA = new Set([
    0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
    0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/** Text the PDF fonts can print, keeping its line breaks. */
export function pdfPrintable(value: unknown): string {
    if (value === null || value === undefined) return "";
    const text = String(value)
        .replace(/₹/g, "Rs.")
        .replace(/[‐-‒−]/g, "-")
        .replace(/\t/g, " ")
        .replace(/[^\n\r\x20-\x7e\xa0-\xff]/g, (ch) => (WIN_ANSI_EXTRA.has(ch.codePointAt(0) ?? 0) ? ch : ""))
        .replace(/ {2,}/g, " ");
    return text.trim() === "null" || text.trim() === "undefined" ? "" : text;
}

/** Text the PDF fonts can print, on one line. */
export function pdfText(value: unknown): string {
    return pdfPrintable(value).replace(/[\r\n]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/** A copy of [value] with every string made printable (line breaks kept). Dates and numbers are left alone. */
export function printableCopy<T>(value: T): T {
    if (typeof value === "string") return pdfPrintable(value) as T;
    if (Array.isArray(value)) return value.map((v) => printableCopy(v)) as T;
    if (value && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, printableCopy(v)])) as T;
    }
    return value;
}

/** Keeps a number and its unit on one line when text wraps ("25 mg", "5 Days", "80 g"). */
export function keepUnits(text: string): string {
    return text.replace(/(\d)\s+(mg|mcg|g|kg|ml|mL|l|L|IU|units?|kcal|cal|tabs?|tablets?|caps?|capsules?|drops?|puffs?|days?|Days?|weeks?|Weeks?|months?|Months?|hrs?|hours?|mins?|minutes?|pieces?|cups?|glass(?:es)?|bowls?|katori)\b/g, "$1 $2");
}
