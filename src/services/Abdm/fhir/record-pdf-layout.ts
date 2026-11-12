import PDFDocument from "pdfkit";
import type { FhirBundle, HiType } from "./fhir-common.js";
import { day, entryLines, join, money, observationValue, personName, quantity, recordView, text, type Resolve } from "./record-view.js";

/**
 * How the PDF of a record looks: the clinic's own prescription PDF (prescription-pdf.service.ts) is
 * the model, so every record a patient receives through ABDM reads as one set. The letterhead,
 * a reference bar, the patient and the doctor side by side, the patient's ABHA, then the record
 * section by section (medicines, results, vaccines and bill lines as tables), and who recorded it.
 *
 * Everything but the logo comes from the bundle itself, so the PDF never says something the
 * structured record does not. Nothing here reads a clock: the same record gives the same bytes.
 */

/** What the PDF shows beyond the bundle: the clinic's logo for its letterhead. */
export interface RecordLetterhead {
    /** PNG or JPEG. */
    logo?: Buffer | null;
}

const WIN_ANSI_EXTRAS = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

/**
 * Text the PDF's built-in fonts can print (WinAnsi). The rupee sign is spelt out; any other character
 * they cannot print becomes "?", so nothing is dropped without a trace.
 */
export const printable = (value: string): string =>
    value
        .replace(/₹\s*/g, "Rs. ")
        .replace(/[  ⁠]/g, (c) => (c === "⁠" ? "" : " "))
        .replace(/[^\n\t\x20-\x7e\xa0-\xff]/g, (c) => (WIN_ANSI_EXTRAS.includes(c) ? c : "?"));

const DATE_TIME = new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata",
});
const DATE = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

const dateOnly = (text: string) => /^\d{4}-\d{2}-\d{2}$/.test(text);

/** A date as the clinic's PDFs print it; with its time, in IST, when the record keeps one. */
export const when = (value: unknown, withTime = true): string | null => {
    if (!value) return null;
    // A date the record keeps without a time is that day, wherever the server runs
    const text = String(value);
    const d = new Date(dateOnly(text) ? `${text}T00:00:00+05:30` : text);
    if (Number.isNaN(d.getTime())) return null;
    return withTime && text.length > 10 ? `${DATE_TIME.format(d)} IST` : DATE.format(d);
};

export const sizeOf = (bytes: number | null) =>
    bytes === null ? null : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export const compositionOf = (bundle: FhirBundle): any => {
    const c = bundle.entry[0]?.resource;
    if (c?.resourceType !== "Composition") throw new Error("A document bundle starts with its Composition.");
    return c;
};

// The prescription PDF's palette
const C = {
    navy: "#1E3A8A", blue: "#0284C7", ink: "#0F172A", body: "#334155", slate: "#475569", muted: "#64748B", faint: "#94A3B8",
    line: "#E2E8F0", rule: "#CBD5E1", panel: "#F8FAFC", white: "#FFFFFF",
    bar: "#F0F9FF", barStroke: "#E0F2FE", badge: "#EFF6FF", badgeStroke: "#BFDBFE", badgeText: "#1E40AF",
    amberBg: "#FFFBEB", amberStroke: "#FDE68A", amber: "#D97706", amberTitle: "#92400E", amberText: "#78350F",
    greenBg: "#F0FDF4", greenStroke: "#BBF7D0", green: "#166534",
    abhaBg: "#ECFDF5", abhaStroke: "#A7F3D0", abha: "#047857",
    red: "#B91C1C",
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 36;
const W = PAGE_W - 2 * M;
/** Where a page's content stops: below it is the page number. */
const BODY_BOTTOM = PAGE_H - 50;

const BADGES: Record<HiType, string> = {
    OPConsultation: "OP CONSULTATION",
    Prescription: "PRESCRIPTION",
    DiagnosticReport: "DIAGNOSTIC REPORT",
    DischargeSummary: "DISCHARGE SUMMARY",
    ImmunizationRecord: "IMMUNIZATION RECORD",
    HealthDocumentRecord: "HEALTH DOCUMENT",
    WellnessRecord: "WELLNESS RECORD",
    Invoice: "INVOICE",
};

const VISITS: Record<string, string> = { AMB: "OPD visit", VR: "Teleconsultation", IMP: "Hospital stay" };

const INVOICE_STATUS: Record<string, string> = { balanced: "Paid", issued: "Issued, not fully paid", draft: "Draft", cancelled: "Cancelled" };

type Font = "Helvetica" | "Helvetica-Bold" | "Helvetica-Oblique";
type Align = "left" | "center" | "right";

interface Cell {
    text: string;
    font?: Font;
    size?: number;
    color?: string;
    /** A smaller second line under it. */
    sub?: string | null;
}
interface Column {
    title: string;
    width: number;
    align?: Align;
}

/** A run of a section's entries drawn one way: a table of one kind, a list, a report, an invoice. */
type Block =
    | { kind: "medicines" | "results" | "vaccines"; entries: any[] }
    | { kind: "list"; items: string[] }
    | { kind: "note"; title: string; body: string }
    | { kind: "report" | "invoice"; entry: any };

const isRecordPdf = (r: any) => (r?.meta?.tag ?? []).some((t: any) => t?.code === "record-pdf");

const rupees = (value: number) => money({ value: Math.round(value * 100) / 100, currency: "INR" }) ?? "";

/** The ABHA number as ABDM prints it: 14 digits in groups of 2-4-4-4. */
const abhaNumberText = (value: string) => {
    const digits = value.replace(/\D/g, "");
    return digits.length === 14 ? `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}-${digits.slice(10)}` : value;
};

/** Whole years from [birth] to [at], or null. */
const ageAt = (birth: unknown, at: Date): number | null => {
    if (!birth) return null;
    const b = new Date(dateOnly(String(birth)) ? `${birth}T00:00:00+05:30` : String(birth));
    if (Number.isNaN(b.getTime()) || b > at) return null;
    const [by, bm, bd] = DATE_PARTS(b);
    const [ay, am, ad] = DATE_PARTS(at);
    return ay - by - (am < bm || (am === bm && ad < bd) ? 1 : 0);
};
const PARTS = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Kolkata" });
const DATE_PARTS = (d: Date) => PARTS.format(d).split("-").map(Number) as [number, number, number];

/** A medicine's dose and schedule without the advice its sentence ends with (that has a column of its own). */
const scheduleOf = (dosage: any): string => {
    const sentence = String(dosage?.text ?? "").trim();
    const advice = String(dosage?.patientInstruction ?? "").trim().replace(/\.$/, "");
    if (!advice) return sentence;
    if (sentence === advice) return "";
    return sentence.endsWith(`. ${advice}`) ? sentence.slice(0, -(advice.length + 2)) : sentence;
};

/** The PDF of what [bundle] says, in the clinic's prescription design. */
export const renderRecordPdf = (hiType: HiType, bundle: FhirBundle, letterhead: RecordLetterhead = {}): Buffer => {
    const view = recordView({ hiType, bundle });
    const c = compositionOf(bundle);
    const byUrl = new Map<string, any>();
    for (const e of bundle.entry) {
        byUrl.set(e.fullUrl, e.resource);
        byUrl.set(`${e.resource.resourceType}/${e.resource.id}`, e.resource);
    }
    const resolve: Resolve = (reference) => (typeof reference === "string" ? byUrl.get(reference) : undefined);
    const patient = resolve(c.subject?.reference);
    const author = resolve(c.author?.[0]?.reference);
    const facility = resolve(c.custodian?.reference);
    const encounter = resolve(c.encounter?.reference);
    const created = new Date(String(c.date ?? bundle.timestamp));
    const facilityName = facility?.name ? String(facility.name) : "ClinicX";
    // A record nobody signed is authored by the facility's staff (abdm-health-record.repository.ts)
    const staff = (author?.identifier ?? []).some((i: any) => i?.type?.coding?.[0]?.code === "EI" && String(i.value ?? "").startsWith("hospital-"));

    const doc = new PDFDocument({
        size: "A4",
        // Pages break where this layout says, not where PDFKit would
        margins: { top: M, bottom: 20, left: M, right: M },
        bufferPages: true,
        // A fixed creation date: the document id derives from it, so the same record gives the same bytes
        info: { Title: printable(view.title), Author: printable(facilityName), Creator: "ClinicX", Producer: "ClinicX", CreationDate: created },
    });

    const style = (font: Font, size: number, color: string) => doc.font(font).fontSize(size).fillColor(color);
    const put = (value: string, x: number, at: number, o: { font?: Font; size?: number; color?: string; width?: number; align?: Align; height?: number; ellipsis?: boolean; spacing?: number; lineGap?: number } = {}) => {
        style(o.font ?? "Helvetica", o.size ?? 9, o.color ?? C.ink);
        const options: PDFKit.Mixins.TextOptions = {};
        if (o.width !== undefined) options.width = o.width;
        if (o.align) options.align = o.align;
        if (o.height !== undefined) options.height = o.height;
        if (o.ellipsis) options.ellipsis = true;
        if (o.spacing) options.characterSpacing = o.spacing;
        if (o.lineGap) options.lineGap = o.lineGap;
        doc.text(printable(value), x, at, options);
        return doc.y;
    };
    const measure = (value: string, width: number, font: Font = "Helvetica", size = 9, lineGap = 0) => {
        doc.font(font).fontSize(size);
        return doc.heightOfString(printable(value), { width, lineGap });
    };
    const widthOf = (value: string, font: Font, size: number) => doc.font(font).fontSize(size).widthOfString(printable(value));

    let y = 0;
    const stripe = () => doc.rect(0, 0, PAGE_W, 5).fill(C.navy);
    /** A new page: the stripe, and what this page continues. */
    const newPage = () => {
        doc.addPage();
        stripe();
        put(`${facilityName}  •  ${view.title} (continued)`, M, 16, { size: 7.5, color: C.muted, width: W, height: 10, ellipsis: true });
        y = 34;
    };
    const ensure = (height: number) => {
        if (y + height > BODY_BOTTOM) newPage();
    };

    // ── Letterhead: logo, the clinic's name, address and contacts, and what record this is ──
    stripe();
    y = 22;
    let headX = M;
    if (letterhead.logo?.length) {
        try {
            doc.image(letterhead.logo, M, y, { fit: [56, 56] });
            headX = M + 66;
        } catch {
            // Not an image PDFKit can draw: the letterhead goes without it
        }
    }
    const badge = BADGES[hiType];
    const badgeW = Math.max(120, widthOf(badge, "Helvetica-Bold", 8) + 24);
    const headW = M + W - badgeW - 12 - headX;
    put(facilityName, headX, y + 2, { font: "Helvetica-Bold", size: 15, color: C.navy, width: headW, height: 19, ellipsis: true });
    let headY = y + 22;
    const address = facility?.address?.[0];
    const addressText = address
        ? join([...(address.line ?? []), address.city, join([address.state, address.postalCode], " - ")], ", ")
        : "";
    if (addressText) headY = put(addressText, headX, headY, { size: 8, color: C.slate, width: headW }) + 3;
    const telecom = (system: string) => (facility?.telecom ?? []).find((t: any) => t?.system === system)?.value as string | undefined;
    const hfr = (facility?.identifier ?? []).find((i: any) => i.system === "https://facility.ndhm.gov.in")?.value;
    const contacts = join([
        telecom("phone") && `Ph: ${telecom("phone")}`,
        telecom("email") && `Email: ${telecom("email")}`,
        telecom("url") && `Web: ${telecom("url")}`,
    ], "  |  ");
    if (contacts) headY = put(contacts, headX, headY, { size: 7.5, color: C.muted, width: headW }) + 2;
    if (hfr) headY = put(`ABDM facility ID (HFR): ${hfr}`, headX, headY, { font: "Helvetica-Bold", size: 7.5, color: C.slate, width: headW });
    doc.roundedRect(M + W - badgeW, y + 8, badgeW, 22, 4).lineWidth(1).fillAndStroke(C.badge, C.badgeStroke);
    put(badge, M + W - badgeW, y + 15, { font: "Helvetica-Bold", size: 8, color: C.badgeText, width: badgeW, align: "center" });

    y = Math.max(86, headY + 8, headX > M ? y + 64 : 0);
    doc.rect(M, y, W, 1.5).fill(C.blue);
    doc.rect(M, y + 1.5, W, 0.5).fill(C.line);
    y += 8;

    // ── Reference bar: the record's title, its date and the visit ──
    {
        const leftW = W * 0.6 - 16;
        const rightW = W * 0.4 - 16;
        const visit = VISITS[encounter?.class?.code] ?? null;
        const visitNo = String(encounter?.identifier?.[0]?.value ?? "").match(/^appointment-(\d+)$/)?.[1];
        const rightLines = [when(c.date) && `Date: ${when(c.date)}`, join([visit, visitNo && `#${visitNo}`], " ")].filter(Boolean) as string[];
        const titleH = measure(view.title, leftW, "Helvetica-Bold", 9);
        const barH = Math.max(titleH, rightLines.length * 11) + 12;
        doc.roundedRect(M, y, W, barH, 4).lineWidth(1).fillAndStroke(C.bar, C.barStroke);
        put(view.title, M + 10, y + 6, { font: "Helvetica-Bold", size: 9, color: C.navy, width: leftW });
        rightLines.forEach((line, i) =>
            put(line, M + W - rightW - 10, y + 6 + i * 11, { font: i ? "Helvetica-Bold" : "Helvetica", size: 8, color: i ? C.blue : C.body, width: rightW, align: "right" }));
        y += barH + 6;
    }

    // ── The patient and the doctor, side by side ──
    {
        const half = W / 2;
        const colW = half - 26;
        const gender = patient?.gender && patient.gender !== "unknown" ? patient.gender[0].toUpperCase() + patient.gender.slice(1) : null;
        const age = ageAt(patient?.birthDate, created);
        const phone = (patient?.telecom ?? []).find((t: any) => t?.system === "phone")?.value;
        const left: Array<[string, Font, number, string]> = [
            ["PATIENT INFORMATION", "Helvetica-Bold", 7.5, C.blue],
            [personName(patient) ?? "Patient", "Helvetica-Bold", 10, C.ink],
            ...(join([age !== null && `Age: ${age} Yrs`, gender && `Gender: ${gender}`, patient?.birthDate && `DOB: ${when(patient.birthDate, false)}`], "  |  ")
                ? [[join([age !== null && `Age: ${age} Yrs`, gender && `Gender: ${gender}`, patient?.birthDate && `DOB: ${when(patient.birthDate, false)}`], "  |  "), "Helvetica", 8, C.body] as [string, Font, number, string]]
                : []),
            ...(phone ? [[`Ph: ${phone}`, "Helvetica", 8, C.muted] as [string, Font, number, string]] : []),
        ];
        const authorName = personName(author);
        const doctorName = authorName && !staff && !/^dr\b/i.test(authorName) ? `Dr. ${authorName}` : authorName;
        const registration = (author?.identifier ?? []).find((i: any) => i?.type?.coding?.[0]?.code === "MD")?.value;
        const qualification = text(author?.qualification?.[0]?.code);
        const right: Array<[string, Font, number, string]> = [
            [staff ? "RECORDED BY" : "CONSULTING DOCTOR", "Helvetica-Bold", 7.5, C.blue],
            [doctorName ?? "Not recorded", "Helvetica-Bold", 10, C.ink],
            ...(qualification ? [[`Qual: ${qualification}`, "Helvetica", 8, C.body] as [string, Font, number, string]] : []),
            ...(registration ? [[`Reg No: ${registration}`, "Helvetica-Bold", 8, C.badgeText] as [string, Font, number, string]] : []),
        ];
        const heightOf = (lines: typeof left) => lines.reduce((h, [value, font, size]) => h + measure(value, colW, font, size) + 3, 0);
        const cardH = Math.max(heightOf(left), heightOf(right)) + 14;
        ensure(cardH);
        doc.roundedRect(M, y, W, cardH, 6).lineWidth(1).fillAndStroke(C.panel, C.line);
        doc.moveTo(M + half, y + 6).lineTo(M + half, y + cardH - 6).strokeColor(C.line).lineWidth(1).stroke();
        const column = (lines: typeof left, x: number) => {
            let at = y + 8;
            for (const [value, font, size, color] of lines) at = put(value, x, at, { font, size, color, width: colW }) + 3;
        };
        column(left, M + 12);
        column(right, M + half + 14);
        y += cardH + 8;
    }

    // ── The patient's ABHA ──
    {
        const ids = patient?.identifier ?? [];
        // The Patient carries the ABHA number as HIN (and as MR under healthid.ndhm.gov.in), the address as ABHA
        const number = ids.find((i: any) => i.type?.coding?.[0]?.code === "HIN" || i.system === "https://healthid.ndhm.gov.in")?.value;
        const address = ids.find((i: any) => i.type?.coding?.[0]?.code === "ABHA")?.value;
        if (number || address) {
            const h = 48;
            ensure(h);
            doc.roundedRect(M, y, W, h, 6).lineWidth(1).fillAndStroke(C.abhaBg, C.abhaStroke);
            doc.roundedRect(M, y, 4, h, 2).fill(C.abha);
            put("ABHA  •  AYUSHMAN BHARAT HEALTH ACCOUNT", M + 14, y + 7, { font: "Helvetica-Bold", size: 7.5, color: C.abha, spacing: 0.3 });
            const fields = [number && ["ABHA number", abhaNumberText(String(number))], address && ["ABHA address", String(address)]].filter(Boolean) as string[][];
            const colW = (W - 28) / 2;
            fields.forEach(([label, value], i) => {
                const x = M + 14 + i * colW;
                put(label!, x, y + 20, { size: 7, color: C.muted });
                put(value!, x, y + 29, { font: "Helvetica-Bold", size: 11, color: C.ink, width: colW - 8, height: 14, ellipsis: true });
            });
            y += h + 12;
        } else {
            y += 4;
        }
    }

    // ── Tables, lists and boxes the record's sections are drawn with ──
    const table = (columns: Column[], rows: Cell[][]) => {
        const header = () => {
            doc.roundedRect(M, y, W, 20, 4).fill(C.navy);
            let x = M;
            for (const col of columns) {
                put(col.title, x + 5, y + 6.5, { font: "Helvetica-Bold", size: 7, color: C.white, width: col.width - 10, align: col.align, height: 9, ellipsis: true });
                x += col.width;
            }
            y += 20;
        };
        const cellHeight = (cell: Cell, width: number) =>
            measure(cell.text, width, cell.font ?? "Helvetica", cell.size ?? 8) + (cell.sub ? 2 + measure(cell.sub, width, "Helvetica", 7) : 0);
        ensure(20 + 26);
        header();
        rows.forEach((row, i) => {
            const h = Math.max(...row.map((cell, j) => cellHeight(cell, columns[j]!.width - 10)), 10) + 12;
            if (y + h > BODY_BOTTOM) {
                newPage();
                header();
            }
            doc.rect(M, y, W, h).fill(i % 2 ? C.panel : C.white);
            doc.moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.5).strokeColor(C.line).stroke();
            let x = M;
            row.forEach((cell, j) => {
                const col = columns[j]!;
                const end = put(cell.text, x + 5, y + 6, { font: cell.font ?? "Helvetica", size: cell.size ?? 8, color: cell.color ?? C.ink, width: col.width - 10, align: col.align });
                if (cell.sub) put(cell.sub, x + 5, end + 2, { size: 7, color: C.muted, width: col.width - 10, align: col.align });
                x += col.width;
            });
            y += h;
        });
        y += 8;
    };
    const index = (i: number): Cell => ({ text: String(i + 1), font: "Helvetica-Bold", color: C.slate });
    const none = (value: string | null | undefined): Cell => (value ? { text: value, color: C.body, size: 7.5 } : { text: "—", color: C.faint, size: 7.5 });

    const list = (lines: string[]) => {
        // "Discharge summary · Discharge summary · 12 Oct 2026": a document's title and type are often the same words
        const items = lines.map((line) => [...new Set(line.split(" · "))].join(" · "));
        for (const item of items) {
            const h = measure(item, W - 16, "Helvetica", 9.5) + 5;
            ensure(h);
            doc.circle(M + 4, y + 5.5, 1.8).fill(C.navy);
            put(item, M + 14, y, { size: 9.5, color: C.ink, width: W - 16 });
            y += h;
        }
        y += 6;
    };

    /** A box of words to read, as the prescription gives its advice. */
    const box = (title: string, body: string) => {
        const h = measure(body, W - 26, "Helvetica", 8.5, 1) + 30;
        ensure(h);
        doc.roundedRect(M, y, W, h, 5).lineWidth(1).fillAndStroke(C.amberBg, C.amberStroke);
        doc.roundedRect(M, y, 4, h, 2).fill(C.amber);
        put(title, M + 12, y + 7, { font: "Helvetica-Bold", size: 8, color: C.amberTitle });
        put(body, M + 12, y + 20, { size: 8.5, color: C.amberText, width: W - 26, lineGap: 1 });
        y += h + 10;
    };

    const medicines = (entries: any[]) => table(
        [
            { title: "#", width: 22, align: "center" },
            { title: "MEDICINE & ROUTE", width: 150 },
            { title: "DOSAGE & SCHEDULE", width: 150 },
            { title: "INSTRUCTIONS", width: 110 },
            { title: "FOR", width: W - 432 },
        ],
        entries.map((r, i) => {
            const dosage = r.dosageInstruction?.[0] ?? r.dosage?.[0];
            const reasons = [...new Set([...(r.reasonCode ?? []).map(text), ...(r.reasonReference ?? []).map((ref: any) => text(resolve(ref?.reference)?.code))].filter(Boolean))];
            const advice = join([dosage?.patientInstruction, ...(r.note ?? []).map((n: any) => n?.text)], ". ");
            return [
                index(i),
                { text: text(r.medicationCodeableConcept) ?? r.medicationReference?.display ?? "Medicine", font: "Helvetica-Bold", size: 8.5, sub: text(dosage?.route) && `Route: ${text(dosage.route)}` },
                scheduleOf(dosage) ? { text: scheduleOf(dosage), font: "Helvetica-Bold", color: C.blue } : none(null),
                none(advice || null),
                none(reasons.join(", ") || null),
            ];
        }),
    );

    const results = (entries: any[]) => {
        const reference = (o: any) => {
            const range = o.referenceRange?.[0];
            const rangeText = range ? (range.text || (range.low || range.high ? `${quantity(range.low) ?? ""} – ${quantity(range.high) ?? ""}` : null)) : null;
            return join([text(o.interpretation?.[0]), rangeText], ", ") || null;
        };
        // An out-of-range result stands out, as on a lab's own report
        const abnormal = (o: any) => {
            const code = String(o.interpretation?.[0]?.coding?.[0]?.code ?? "");
            return /^(L|H|LL|HH|A|AA|<|>)$/.test(code) || /\b(low|high|abnormal|critical)\b/i.test(text(o.interpretation?.[0]) ?? "");
        };
        // Each row's time only when they differ: the same time on every row says nothing
        const times = new Set(entries.map((o) => when(o.effectiveDateTime)));
        const withTime = times.size > 1;
        const withReference = entries.some(reference);
        table(
            [
                { title: "#", width: 22, align: "center" },
                { title: "TEST / PARAMETER", width: withReference ? 190 : 250 },
                { title: "RESULT", width: withReference ? 160 : W - 272 },
                ...(withReference ? [{ title: "REFERENCE / FLAG", width: W - 372 }] : []),
            ],
            entries.map((o, i) => [
                index(i),
                { text: text(o.code) ?? "Observation", font: "Helvetica-Bold", size: 8.5, sub: withTime ? when(o.effectiveDateTime) : null },
                { text: observationValue(o) ?? "—", font: abnormal(o) ? "Helvetica-Bold" : "Helvetica", color: abnormal(o) ? C.red : C.ink },
                ...(withReference ? [abnormal(o) ? { text: reference(o)!, font: "Helvetica-Bold" as Font, size: 7.5, color: C.red } : none(reference(o))] : []),
            ]),
        );
    };

    const vaccines = (entries: any[]) => table(
        [
            { title: "#", width: 22, align: "center" },
            { title: "VACCINE", width: 190 },
            { title: "DOSE", width: 55, align: "center" },
            { title: "GIVEN ON", width: 85 },
            { title: "DETAILS", width: W - 352 },
        ],
        entries.map((r, i) => [
            index(i),
            { text: text(r.vaccineCode) ?? "Vaccine", font: "Helvetica-Bold", size: 8.5, sub: text(r.route) && `Route: ${text(r.route)}` },
            { text: String(r.protocolApplied?.[0]?.doseNumberPositiveInt ?? r.protocolApplied?.[0]?.doseNumberString ?? "—"), color: C.body },
            { text: day(r.occurrenceDateTime) ?? "—", color: C.body },
            none(join([r.manufacturer?.display && `Manufacturer: ${r.manufacturer.display}`, r.lotNumber && `Lot: ${r.lotNumber}`, text(r.site) && `Site: ${text(r.site)}`], " · ") || null),
        ]),
    );

    const report = (r: any) => {
        const specimen = resolve(r.specimen?.[0]?.reference);
        list([
            join([text(r.code) ?? "Report", text(r.category?.[0]), day(r.issued ?? r.effectiveDateTime) && `issued ${day(r.issued ?? r.effectiveDateTime)}`]),
            ...(specimen ? [`Specimen: ${join([text(specimen.type), day(specimen.collection?.collectedDateTime) && `collected ${day(specimen.collection?.collectedDateTime)}`], ", ")}`] : []),
            ...((r.performer ?? []).slice(1).map((p: any) => p?.display).filter(Boolean).map((p: string) => `Performed by: ${p}`)),
        ]);
        const found = (r.result ?? []).map((ref: any) => resolve(ref?.reference)).filter(Boolean);
        if (found.length) results(found);
        if (r.conclusion) box("CONCLUSION", r.conclusion);
    };

    const invoice = (inv: any) => {
        const sum = (components: any[], type: string) => components.filter((p) => p?.type === type).reduce((a, p) => a + Number(p.amount?.value ?? 0), 0);
        const taxes = new Map<string, number>();
        const lines = (inv.lineItem ?? []).map((li: any) => {
            const charge = resolve(li.chargeItemReference?.reference);
            const components = li.priceComponent ?? [];
            for (const p of components.filter((p: any) => p?.type === "tax")) {
                const name = text(p.code) ?? "Tax";
                taxes.set(name, (taxes.get(name) ?? 0) + Number(p.amount?.value ?? 0));
            }
            const qty = Number(charge?.quantity?.value ?? 1) || 1;
            const base = sum(components, "base");
            return { name: text(charge?.productCodeableConcept) ?? text(charge?.code) ?? text(li.chargeItemCodeableConcept) ?? "Item", kind: text(charge?.code), qty, base, discount: sum(components, "discount"), tax: sum(components, "tax") };
        });
        table(
            [
                { title: "#", width: 22, align: "center" },
                { title: "ITEM", width: 200 },
                { title: "QTY", width: 40, align: "center" },
                { title: "RATE", width: 70, align: "right" },
                { title: "DISCOUNT", width: 62, align: "right" },
                { title: "TAX", width: 60, align: "right" },
                { title: "AMOUNT", width: W - 454, align: "right" },
            ],
            lines.map((l: any, i: number) => [
                index(i),
                { text: l.name, font: "Helvetica-Bold", size: 8.5, sub: l.kind && l.kind !== l.name ? l.kind : null },
                { text: String(l.qty), color: C.body },
                { text: rupees(l.base / l.qty), color: C.body },
                { text: l.discount ? `- ${rupees(l.discount)}` : "—", color: l.discount ? C.body : C.faint },
                { text: l.tax ? rupees(l.tax) : "—", color: l.tax ? C.body : C.faint },
                { text: rupees(l.base - l.discount + l.tax), font: "Helvetica-Bold", color: C.ink },
            ]),
        );
        // The totals, under the amount column
        const totals: Array<[string, string, boolean]> = [
            ["Items total", rupees(lines.reduce((a: number, l: any) => a + l.base, 0)), false],
            ...(lines.some((l: any) => l.discount) ? [["Discount", `- ${rupees(lines.reduce((a: number, l: any) => a + l.discount, 0))}`, false] as [string, string, boolean]] : []),
            ...[...taxes].map(([name, amount]) => [name, rupees(amount), false] as [string, string, boolean]),
            ["Total", money(inv.totalGross) ?? "—", true],
        ];
        const boxW = 220;
        const h = totals.length * 15 + 30;
        ensure(h);
        const x = M + W - boxW;
        doc.roundedRect(x, y, boxW, h, 5).lineWidth(1).fillAndStroke(C.panel, C.line);
        totals.forEach(([label, value, strong], i) => {
            const at = y + 8 + i * 15;
            if (strong) doc.moveTo(x + 10, at - 3).lineTo(x + boxW - 10, at - 3).lineWidth(0.75).strokeColor(C.rule).stroke();
            put(label, x + 10, at, { font: strong ? "Helvetica-Bold" : "Helvetica", size: strong ? 9.5 : 8, color: strong ? C.navy : C.slate, width: 100 });
            put(value, x + 110, at, { font: strong ? "Helvetica-Bold" : "Helvetica", size: strong ? 9.5 : 8, color: strong ? C.navy : C.ink, width: boxW - 120, align: "right" });
        });
        const status = INVOICE_STATUS[inv.status];
        if (status) put(`Status: ${status}`, x + 10, y + h - 16, { font: "Helvetica-Bold", size: 7.5, color: inv.status === "balanced" ? C.green : C.amberTitle, width: boxW - 20, align: "right" });
        y += h + 10;
    };

    const draw = (b: Block) => {
        switch (b.kind) {
            case "medicines": return medicines(b.entries);
            case "results": return results(b.entries);
            case "vaccines": return vaccines(b.entries);
            case "list": return list(b.items);
            case "note": return box(b.title, b.body);
            case "report": return report(b.entry);
            case "invoice": return invoice(b.entry);
        }
    };

    /** A section's entries as blocks: entries of one table kind next to each other share a table. */
    const blocksOf = (entries: any[]): Block[] => {
        const blocks: Block[] = [];
        for (const r of entries) {
            const observation = r.resourceType === "Observation";
            // A note the doctor wrote reads as the prescription's advice box; a finding with no value is a line
            const note = observation && typeof r.valueString === "string" && /\bnote\b/i.test(text(r.code) ?? "");
            const valueless = observation && observationValue(r) === null;
            const kind = r.resourceType === "MedicationRequest" || r.resourceType === "MedicationStatement" ? "medicines"
                : note ? "note"
                    : observation && !valueless ? "results"
                        : r.resourceType === "Immunization" ? "vaccines"
                            : r.resourceType === "DiagnosticReport" ? "report"
                                : r.resourceType === "Invoice" ? "invoice"
                                    : "list";
            const last = blocks[blocks.length - 1];
            if (kind === "note") blocks.push({ kind, title: (text(r.code) ?? "Note").toUpperCase(), body: r.valueString });
            else if (kind === "report" || kind === "invoice") blocks.push({ kind, entry: r });
            else if (kind === "list") {
                const items = entryLines(r, resolve);
                if (!items.length) continue;
                if (last?.kind === "list") last.items.push(...items);
                else blocks.push({ kind, items });
            } else if (last?.kind === kind) last.entries.push(r);
            else blocks.push({ kind, entries: [r] });
        }
        return blocks;
    };

    /** How much of a block must fit under its section's heading, so a heading never ends a page alone. */
    const firstHeight = (b: Block): number => {
        switch (b.kind) {
            case "list": return measure(b.items[0] ?? "", W - 16, "Helvetica", 9.5) + 6;
            case "note": return measure(b.body, W - 26, "Helvetica", 8.5, 1) + 30;
            case "report": return 40;
            default: return 48;
        }
    };
    /** A section's heading: medicines under the prescription's Rx tile, anything else under a bar. */
    const heading = (title: string, first?: Block) => {
        ensure(24 + (first ? firstHeight(first) : 48));
        if (first?.kind === "medicines") {
            doc.roundedRect(M, y - 2, 24, 18, 4).fill(C.navy);
            put("Rx", M, y + 2, { font: "Helvetica-Bold", size: 10, color: C.white, width: 24, align: "center" });
            put(title.toUpperCase(), M + 32, y + 2.5, { font: "Helvetica-Bold", size: 10, color: C.navy, width: W - 32, spacing: 0.3 });
        } else {
            doc.rect(M, y, 4, 14).fill(C.navy);
            put(title.toUpperCase(), M + 12, y + 2.5, { font: "Helvetica-Bold", size: 10, color: C.navy, width: W - 12, spacing: 0.3 });
        }
        y += 24;
    };

    // ── The record, section by section, as the bundle's Composition orders it ──
    const walk = (sections: any[] | undefined) => {
        for (const s of sections ?? []) {
            const entries = (s.entry ?? []).map((ref: any) => resolve(ref?.reference))
                // The record's own PDF is this file; a signed copy is listed with the files
                .filter((r: any) => r && !isRecordPdf(r) && r.resourceType !== "Binary");
            const blocks = blocksOf(entries);
            if (blocks.length) {
                heading(String(s.title ?? text(s.code) ?? "Section"), blocks[0]!);
                for (const b of blocks) draw(b);
                y += 4;
            }
            walk(s.section);
        }
    };
    walk(c.section);

    if (view.attachments.length) {
        heading("Files sent with this record");
        table(
            [
                { title: "#", width: 22, align: "center" },
                { title: "FILE", width: 300 },
                { title: "TYPE", width: 100 },
                { title: "SIZE", width: W - 422, align: "right" },
            ],
            view.attachments.map((a, i) => [
                index(i),
                { text: a.title, font: "Helvetica-Bold", size: 8.5 },
                { text: a.contentType?.split("/")[1]?.toUpperCase() ?? "—", color: C.body },
                { text: sizeOf(a.bytes) ?? "—", color: C.body },
            ]),
        );
    }

    // ── Who recorded it, at the foot of the last page, as the prescription is signed ──
    {
        const h = 62;
        const at = BODY_BOTTOM - h;
        // At the foot of the page the record ends on, or of a page of its own when it does not fit
        if (y > at - 14) newPage();
        doc.rect(M, at - 10, W, 0.75).fill(C.rule);
        put(
            `This is an electronically generated copy of a health record from ${facilityName}, shared with the patient through ABDM. `
            + "It shows the same information as the structured record it is attached to.",
            M, at + 12, { font: "Helvetica-Oblique", size: 7.5, color: C.muted, width: W - 190, lineGap: 3 },
        );
        const boxW = 160;
        const x = M + W - boxW;
        doc.roundedRect(x, at - 4, boxW, h - 4, 5).lineWidth(1).fillAndStroke(C.greenBg, C.greenStroke);
        const name = personName(author);
        const registration = (author?.identifier ?? []).find((i: any) => i?.type?.coding?.[0]?.code === "MD")?.value;
        put("RECORDED BY", x, at + 2, { font: "Helvetica-Bold", size: 7.5, color: C.green, width: boxW, align: "center" });
        put(name ? (!staff && !/^dr\b/i.test(name) ? `Dr. ${name}` : name) : facilityName, x + 6, at + 15, { font: "Helvetica-Bold", size: 9, color: C.ink, width: boxW - 12, align: "center", height: 12, ellipsis: true });
        if (registration) put(`Reg No: ${registration}`, x, at + 29, { size: 7, color: C.green, width: boxW, align: "center" });
        put(`Recorded: ${when(c.date) ?? "—"}`, x, at + 40, { font: "Helvetica-Oblique", size: 6.5, color: C.muted, width: boxW, align: "center" });
    }

    // ── Page numbers ──
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const bottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        put(`Page ${i - range.start + 1} of ${range.count}  •  Electronic health record shared through ABDM`, M, PAGE_H - 30, { size: 7, color: C.faint, width: W, align: "center" });
        doc.page.margins.bottom = bottom;
    }

    doc.end();
    // PDFKit writes the whole file synchronously into the stream's buffer by end(); nothing is left to flow
    const out = doc.read() as Buffer | null;
    const complete = out && out.subarray(0, 5).toString("latin1") === "%PDF-" && /%%EOF\s*$/.test(out.subarray(-16).toString("latin1"));
    if (complete) return out;
    // A logo PDFKit could only draw later would leave the file cut short: the record goes without it
    if (letterhead.logo?.length) return renderRecordPdf(hiType, bundle, {});
    throw new Error("The record PDF could not be written.");
};
