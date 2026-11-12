import { createHash } from "node:crypto";
import { LOCAL_SYSTEM, NRCES, SNOMED, narrative, resourceId, type FhirBundle, type FhirResource, type HiType } from "./fhir-common.js";
import { compositionOf, renderRecordPdf, type RecordLetterhead } from "./record-pdf-layout.js";

export { printable, renderRecordPdf, type RecordLetterhead } from "./record-pdf-layout.js";

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
export const withRecordPdf = (
    hiType: HiType,
    build: (pdf: FhirResource[]) => FhirBundle,
    as: RecordPdfAs = { kind: "DocumentReference" },
    letterhead: RecordLetterhead = {},
): FhirBundle => {
    const draft = build([]);
    const pdf = renderRecordPdf(hiType, draft, letterhead);
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
