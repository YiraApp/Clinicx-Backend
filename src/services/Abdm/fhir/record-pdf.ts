import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import { LOCAL_SYSTEM, NRCES, SNOMED, narrative, resourceId, type FhirBundle, type FhirResource, type HiType } from "./fhir-common.js";
import { recordView } from "./record-view.js";

/**
 * The unstructured copy of a record: a PDF of what its bundle says, carried inside that same bundle
 * so a PHR app that does not read the structured resources still shows the record. Built from the
 * bundle itself (its record view), so the PDF can never say something the structured data does not.
 *
 * Where it goes follows NRCES's own examples (IG 6.5.0): a DocumentReference in the section a profile
 * keeps for documents (OPConsultation, DischargeSummary and WellnessRecord's DocumentReference slice;
 * the single section of DiagnosticReport and ImmunizationRecord; a sub-section of Invoice's, whose own
 * entries are closed to all but the Invoice), and a Binary in a Prescription's section.
 * HealthDocumentRecord is already unstructured and gets none.
 *
 * The PDF is deterministic: the same record gives the same bytes, so what staff preview is what is sent.
 */

const RECORD_PDF_TAG = { system: `${LOCAL_SYSTEM}/record-pdf`, code: "record-pdf", display: "PDF of the record" };

const HI_TYPE_LABELS: Record<HiType, string> = {
    OPConsultation: "OP consultation",
    Prescription: "Prescription",
    DiagnosticReport: "Diagnostic report",
    DischargeSummary: "Discharge summary",
    ImmunizationRecord: "Immunization record",
    HealthDocumentRecord: "Health document",
    WellnessRecord: "Wellness record",
    Invoice: "Invoice",
};

const WIN_ANSI_EXTRAS = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

/**
 * Text the PDF's built-in fonts can print (WinAnsi). The rupee sign is spelt out; any other character
 * they cannot print becomes "?", so nothing is dropped without a trace.
 */
export const printable = (text: string): string =>
    text
        .replace(/₹\s*/g, "Rs. ")
        .replace(/[  ⁠]/g, (c) => (c === "⁠" ? "" : " "))
        .replace(/[^\n\t\x20-\x7e\xa0-\xff]/g, (c) => (WIN_ANSI_EXTRAS.includes(c) ? c : "?"));

const DATE_TIME = new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata",
});
const DATE = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

const when = (value: unknown, withTime = true): string | null => {
    if (!value) return null;
    // A date the record keeps without a time is that day, wherever the server runs
    const text = String(value);
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00+05:30` : text);
    if (Number.isNaN(d.getTime())) return null;
    return (withTime && text.length > 10 ? DATE_TIME : DATE).format(d);
};

const sizeOf = (bytes: number | null) =>
    bytes === null ? null : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const compositionOf = (bundle: FhirBundle): any => {
    const c = bundle.entry[0]?.resource;
    if (c?.resourceType !== "Composition") throw new Error("A document bundle starts with its Composition.");
    return c;
};

/** The PDF of what [bundle] says: facility, patient, doctor, each section's lines, and the files it carries. */
export const renderRecordPdf = (hiType: HiType, bundle: FhirBundle): Buffer => {
    const view = recordView({ hiType, bundle });
    const c = compositionOf(bundle);
    const byUrl = new Map<string, any>(bundle.entry.map((e) => [e.fullUrl, e.resource]));
    const patient = byUrl.get(c.subject?.reference);
    const author = byUrl.get(c.author?.[0]?.reference);
    const facility = byUrl.get(c.custodian?.reference);
    const created = new Date(String(c.date ?? bundle.timestamp));

    const doc = new PDFDocument({
        size: "A4",
        margins: { top: 50, bottom: 60, left: 50, right: 50 },
        bufferPages: true,
        // A fixed creation date: the document id derives from it, so the same record gives the same bytes
        info: { Title: printable(view.title), Author: printable(facility?.name ?? "ClinicX"), Creator: "ClinicX", Producer: "ClinicX", CreationDate: created },
    });
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;
    const write = (text: string, font: "Helvetica" | "Helvetica-Bold", size: number, color = "#0f172a", options: PDFKit.Mixins.TextOptions = {}) =>
        doc.font(font).fontSize(size).fillColor(color).text(printable(text), { width, ...options });

    // Facility
    if (facility?.name) write(facility.name, "Helvetica-Bold", 15);
    const hfr = (facility?.identifier ?? []).find((i: any) => i.system === "https://facility.ndhm.gov.in")?.value;
    const contacts = (facility?.telecom ?? []).map((t: any) => t.value).filter(Boolean);
    const facilityLine = [hfr ? `HFR ID ${hfr}` : null, ...contacts].filter(Boolean).join("  ·  ");
    if (facilityLine) write(facilityLine, "Helvetica", 9, "#475569");
    doc.moveDown(0.6);
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.7).strokeColor("#cbd5e1").stroke();
    doc.moveDown(0.8);

    // The record
    write(view.title, "Helvetica-Bold", 14);
    write([HI_TYPE_LABELS[hiType], when(view.date)].filter(Boolean).join("  ·  "), "Helvetica", 9.5, "#475569");
    doc.moveDown(0.8);

    const details: Array<[string, string | null]> = [
        ["Patient", patient?.name?.[0]?.text ?? null],
        ["Gender", patient?.gender && patient.gender !== "unknown" ? patient.gender[0].toUpperCase() + patient.gender.slice(1) : null],
        ["Date of birth", when(patient?.birthDate, false)],
        ["ABHA address", (patient?.identifier ?? []).find((i: any) => i.type?.coding?.[0]?.code === "ABHA")?.value ?? null],
        ["Doctor", author ? [author.name?.[0]?.text, author.identifier?.[0]?.type?.coding?.[0]?.code === "MD" ? `Reg. no. ${author.identifier[0].value}` : null].filter(Boolean).join(", ") : null],
    ];
    for (const [label, value] of details) {
        if (!value) continue;
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#475569").text(`${label}: `, { continued: true, width });
        doc.font("Helvetica").fillColor("#0f172a").text(printable(value), { width });
    }
    doc.moveDown(0.8);

    // What it says, section by section, in the words of the record view staff see
    for (const s of view.sections) {
        write(s.title.toUpperCase(), "Helvetica-Bold", 9, "#334155", { characterSpacing: 0.4 });
        doc.moveDown(0.2);
        doc.font("Helvetica").fontSize(10).fillColor("#0f172a").list(s.items.map(printable), { width, bulletRadius: 1.6, textIndent: 12, bulletIndent: 4 });
        doc.moveDown(0.7);
    }

    if (view.attachments.length) {
        write("FILES SENT WITH THIS RECORD", "Helvetica-Bold", 9, "#334155", { characterSpacing: 0.4 });
        doc.moveDown(0.2);
        const files = view.attachments.map((a) => [a.title, [a.contentType?.split("/")[1]?.toUpperCase(), sizeOf(a.bytes)].filter(Boolean).join(", ")].filter(Boolean).join(" ("))
            .map((line) => (line.includes(" (") ? `${line})` : line));
        doc.font("Helvetica").fontSize(10).fillColor("#0f172a").list(files.map(printable), { width, bulletRadius: 1.6, textIndent: 12, bulletIndent: 4 });
    }

    // Footer on every page, below the bottom margin
    const range = doc.bufferedPageRange();
    const footer = printable(`Shared${facility?.name ? ` by ${facility.name}` : ""} through ABDM. This PDF shows the same record as the structured data it is attached to.`);
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const bottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        const y = doc.page.height - 40;
        doc.font("Helvetica").fontSize(7.5).fillColor("#64748b");
        doc.text(footer, left, y, { width: width - 70, lineBreak: false, ellipsis: true });
        doc.text(`Page ${i - range.start + 1} of ${range.count}`, left + width - 70, y, { width: 70, align: "right", lineBreak: false });
        doc.page.margins.bottom = bottom;
    }

    doc.end();
    // PDFKit writes the whole file synchronously into the stream's buffer by end(); nothing is left to flow
    const out = doc.read() as Buffer | null;
    if (!out || out.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("The record PDF could not be written.");
    return out;
};

/** FHIR Attachment.hash: the SHA-1 of the data, base64. */
const sha1 = (data: Buffer) => createHash("sha1").update(data).digest("base64");

/** The PDF as a DocumentReference, typed as [type] (SNOMED CT) or as a record artifact. */
export const recordPdfDocumentReference = (bundle: FhirBundle, pdf: Buffer, type?: { code: string; display: string }): FhirResource => {
    const c = compositionOf(bundle);
    const title = `${c.title} (PDF)`;
    return {
        resourceType: "DocumentReference",
        id: resourceId("DocumentReference", `record-pdf:${bundle.id}`),
        meta: { profile: [NRCES + "DocumentReference"], tag: [RECORD_PDF_TAG] },
        text: narrative(`${title} (application/pdf)`),
        status: "current",
        docStatus: "final",
        type: type
            ? { coding: [{ system: SNOMED, code: type.code, display: type.display }], text: type.display }
            : { coding: [{ system: SNOMED, code: "419891008", display: "Record artifact" }], text: c.type?.text ?? c.title },
        subject: c.subject,
        date: c.date,
        description: title,
        content: [{
            attachment: {
                contentType: "application/pdf",
                language: "en-IN",
                data: pdf.toString("base64"),
                title,
                creation: c.date,
                size: pdf.length,
                hash: sha1(pdf),
            },
        }],
    };
};

/** The PDF as a Binary, as a Prescription carries it (NRCES's Prescription example). */
export const recordPdfBinary = (bundle: FhirBundle, pdf: Buffer): FhirResource => ({
    resourceType: "Binary",
    id: resourceId("Binary", `record-pdf:${bundle.id}`),
    meta: { profile: [NRCES + "Binary"], tag: [RECORD_PDF_TAG] },
    contentType: "application/pdf",
    data: pdf.toString("base64"),
});

export type RecordPdfAs = { kind: "DocumentReference"; type?: { code: string; display: string } } | { kind: "Binary" };

/**
 * A record's bundle with its PDF inside. [build] makes the bundle with the given resources in the
 * section that carries documents; it runs twice, once without them to read what the record says, then
 * with the PDF of that. The resource ids are the record's own, so both runs agree on them.
 */
export const withRecordPdf = (hiType: HiType, build: (pdf: FhirResource[]) => FhirBundle, as: RecordPdfAs = { kind: "DocumentReference" }): FhirBundle => {
    const draft = build([]);
    const pdf = renderRecordPdf(hiType, draft);
    return build([as.kind === "Binary" ? recordPdfBinary(draft, pdf) : recordPdfDocumentReference(draft, pdf, as.type)]);
};

export interface RecordPdf {
    title: string;
    data: Buffer;
    /** "generated": the PDF of the record built here; "signed-copy": the clinic's own prescription PDF. */
    source: "generated" | "signed-copy";
}

const isRecordPdf = (r: any) => (r?.meta?.tag ?? []).some((t: any) => t?.system === RECORD_PDF_TAG.system && t?.code === RECORD_PDF_TAG.code);

/**
 * The PDF of the record a bundle carries, exactly as it will be sent: the one built here, or else a
 * prescription's own signed copy. None for a record that carries no PDF of itself (a health document,
 * a report that is only its uploaded file).
 */
export const recordPdfOf = (bundle: FhirBundle): RecordPdf | null => {
    const c = bundle.entry[0]?.resource as any;
    const title = String(c?.title ?? "Record");
    const resources = bundle.entry.map((e) => e.resource as any);
    const own = resources.find(isRecordPdf);
    if (own?.resourceType === "DocumentReference") {
        const a = own.content?.[0]?.attachment;
        if (a?.contentType === "application/pdf" && typeof a.data === "string") return { title: a.title ?? title, data: Buffer.from(a.data, "base64"), source: "generated" };
    }
    if (own?.resourceType === "Binary" && typeof own.data === "string") return { title: `${title} (PDF)`, data: Buffer.from(own.data, "base64"), source: "generated" };
    const signed = resources.find((r) => r.resourceType === "Binary" && r.contentType === "application/pdf" && typeof r.data === "string");
    return signed ? { title: `${title} (signed copy)`, data: Buffer.from(signed.data, "base64"), source: "signed-copy" } : null;
};
