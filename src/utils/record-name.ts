/**
 * Readable names for health records. Stored file names are often made by machines
 * ("Prescription_29ACFBFA-09A2-4FCB-8927-C433BFC928F2.pdf", "IMG_20261112_101010.jpg");
 * patients should see "Prescription · 12 Nov 2026" instead.
 */
const GUID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;
const LONG_HEX = /[0-9a-f]{16,}/gi;
const DATE_STAMP = /\d{4}[-_]\d{2}[-_]\d{2}([-_T]\d{2}[-_:]?\d{2}([-_:]?\d{2})?)?/g;
const DIGITS = /\d{4,}/g;
const EXT = /\.([a-z0-9]{2,5})$/i;
const GENERIC = new Set(["document", "file", "image", "img", "photo", "scan", "upload", "record", "report", "pdf"]);

/** "12 Nov 2026" in India time */
export const recordDate = (date: Date = new Date()) =>
    date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

const titleCase = (s: string) =>
    s.split(" ").filter(Boolean).map(w => (w.length <= 3 && w.toUpperCase() === w ? w : w[0].toUpperCase() + w.slice(1))).join(" ");

/** True when a file name was generated (ids, timestamps, camera names) rather than chosen by a person. */
export function isMachineFileName(name: string): boolean {
    const base = String(name || "").trim().replace(EXT, "");
    if (!base) return true;
    return [GUID, LONG_HEX, DATE_STAMP, /\d{8,}/].some(re => new RegExp(re.source, "i").test(base))
        || GENERIC.has(base.toLowerCase().replace(/[^a-z]/g, ""));
}

/**
 * The name to show for a record: a person's own file name unchanged, otherwise
 * "<what it is> · <date>", e.g. "Prescription · 12 Nov 2026". Never contains a dot.
 */
export function readableRecordName(name: string | null | undefined, category?: string | null, date?: Date | null): string {
    const raw = String(name || "").trim();
    if (raw && !isMachineFileName(raw)) {
        const base = raw.replace(EXT, "");
        // "Prescription_sreelatha_devireddy_05-Nov-2026.pdf" → "Prescription sreelatha devireddy 05-Nov-2026"
        return base.includes("_") && !base.includes(" ") ? base.replace(/_+/g, " ").trim() : raw;
    }
    const prefix = raw.replace(EXT, "")
        .replace(GUID, " ").replace(LONG_HEX, " ").replace(DATE_STAMP, " ").replace(DIGITS, " ")
        .replace(/[_\-.]+/g, " ")
        .replace(/\b(IMG|DOC|PXL|SCAN|VID|WA|DCIM|file|image|document|upload)\b/gi, " ")
        .replace(/\s+/g, " ").trim();
    const cat = String(category || "").trim();
    const what = titleCase(prefix.length >= 3 ? prefix : cat && cat.toLowerCase() !== "general" ? cat : "Health record").replace(/\./g, "");
    return date === null ? what : `${what} · ${recordDate(date || new Date())}`;
}

/** File name for a downloaded copy: "Prescription - Dr Ravi Kumar - 12 Nov 2026.pdf" */
export function prescriptionFileName(doctorName?: string | null, date: Date = new Date()): string {
    const doctor = String(doctorName || "").replace(/^dr\.?\s*/i, "").replace(/[^\p{L}\p{N} ]/gu, "").trim();
    return `Prescription${doctor ? ` - Dr ${doctor}` : ""} - ${recordDate(date)}.pdf`;
}
