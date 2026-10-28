import type { FhirBundle, FhirResource, HiType } from "./fhir-common.js";

/**
 * A FHIR document bundle as staff read it: what the patient's PHR app receives for one record, in
 * words. Read from the bundle itself, so it shows exactly what is shared, and leaves out what the
 * bundle does not say rather than writing "NA".
 */

export interface RecordViewSection {
    title: string;
    items: string[];
}

export interface RecordViewAttachment {
    title: string;
    contentType: string | null;
    bytes: number | null;
}

export interface RecordView {
    hiType: HiType;
    title: string;
    date: string | null;
    author: string | null;
    sections: RecordViewSection[];
    attachments: RecordViewAttachment[];
}

type Resolve = (reference: unknown) => any;

const text = (cc: any): string | null => cc?.text || cc?.coding?.find((c: any) => c?.display)?.display || null;

const join = (parts: Array<string | null | undefined | false>, separator = " · ") => parts.filter(Boolean).join(separator);

const DAY = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

const day = (value: unknown): string | null => {
    const d = value ? new Date(String(value)) : null;
    return d && !Number.isNaN(d.getTime()) ? DAY.format(d) : null;
};

const quantity = (q: any): string | null => (q?.value === undefined || q?.value === null ? null : `${q.value}${q.unit ? ` ${q.unit}` : ""}`);

const money = (m: any): string | null =>
    m?.value === undefined || m?.value === null
        ? null
        : `${!m.currency || m.currency === "INR" ? "₹" : `${m.currency} `}${Number(m.value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const personName = (r: any): string | null => {
    const n = r?.name?.[0];
    if (!n) return typeof r?.name === "string" ? r.name : null;
    return n.text || join([...(n.prefix ?? []), ...(n.given ?? []), n.family], " ") || null;
};

/** An Observation's value: a quantity, words, a code, or its components (blood pressure as 120/80 mmHg). */
const observationValue = (o: any): string | null => {
    const direct = quantity(o.valueQuantity) ?? o.valueString ?? text(o.valueCodeableConcept)
        ?? (typeof o.valueBoolean === "boolean" ? (o.valueBoolean ? "Yes" : "No") : null)
        ?? (o.valueInteger ?? null);
    if (direct !== null && direct !== undefined) return String(direct);
    const parts = (o.component ?? []).filter((c: any) => c?.valueQuantity?.value !== undefined);
    if (!parts.length) return null;
    const unit = parts[0].valueQuantity.unit;
    if (parts.every((c: any) => c.valueQuantity.unit === unit)) return `${parts.map((c: any) => c.valueQuantity.value).join("/")}${unit ? ` ${unit}` : ""}`;
    return parts.map((c: any) => `${text(c.code) ?? "Value"} ${quantity(c.valueQuantity)}`).join(", ");
};

const observationLine = (o: any): string => {
    const value = observationValue(o);
    const range = o.referenceRange?.[0];
    const rangeText = range ? (range.text || (range.low || range.high ? `range ${quantity(range.low) ?? ""}–${quantity(range.high) ?? ""}` : null)) : null;
    const flag = text(o.interpretation?.[0]);
    const label = text(o.code) ?? "Observation";
    const extras = join([flag, rangeText], ", ");
    return `${value ? `${label}: ${value}` : label}${extras ? ` (${extras})` : ""}`;
};

const INVOICE_STATUS: Record<string, string> = { balanced: "Paid", issued: "Issued, not fully paid", draft: "Draft", cancelled: "Cancelled" };

const invoiceLines = (inv: any, resolve: Resolve): string[] => {
    const lines = (inv.lineItem ?? []).map((li: any) => {
        const charge = resolve(li.chargeItemReference?.reference);
        const name = text(charge?.productCodeableConcept) ?? text(charge?.code) ?? text(li.chargeItemCodeableConcept) ?? "Item";
        const of = (type: string) => (li.priceComponent ?? []).filter((p: any) => p.type === type);
        const sum = (type: string) => of(type).reduce((total: number, p: any) => total + Number(p.amount?.value ?? 0), 0);
        const qty = charge?.quantity?.value && charge.quantity.value !== 1 ? ` × ${charge.quantity.value}` : "";
        return join([
            `${name}${qty}: ${money(of("base")[0]?.amount) ?? "—"}`,
            of("discount").length ? `less ${money({ value: sum("discount"), currency: "INR" })}` : null,
            of("tax").length ? `tax ${money({ value: sum("tax"), currency: "INR" })}` : null,
        ], ", ");
    });
    const total = join([
        inv.totalGross ? `Total ${money(inv.totalGross)}` : null,
        inv.totalNet && inv.totalGross && inv.totalNet.value !== inv.totalGross.value ? `before tax ${money(inv.totalNet)}` : null,
        INVOICE_STATUS[inv.status] ?? null,
    ], " · ");
    return total ? [...lines, total] : lines;
};

/** What one resource says, as one line or a few (a report and its results; an invoice and its items). */
const lines = (r: any, resolve: Resolve): string[] => {
    switch (r?.resourceType) {
        case "Condition":
        case "AllergyIntolerance":
        case "ServiceRequest":
            return [text(r.code) ?? r.resourceType];
        case "Procedure":
            return [join([text(r.code) ?? "Procedure", day(r.performedDateTime ?? r.performedPeriod?.start)])];
        case "Observation":
            return [observationLine(r)];
        case "MedicationRequest":
        case "MedicationStatement":
        {
            // The diagnosis it treats, which a Prescription record carries only here
            const reasons = [...(r.reasonCode ?? []).map(text), ...(r.reasonReference ?? []).map((ref: any) => text(resolve(ref?.reference)?.code))].filter(Boolean);
            const medicine = join([text(r.medicationCodeableConcept) ?? r.medicationReference?.display ?? "Medicine", r.dosageInstruction?.[0]?.text ?? r.dosage?.[0]?.text], " — ");
            return [reasons.length ? `${medicine} (for ${[...new Set(reasons)].join(", ")})` : medicine];
        }
        case "DiagnosticReport": {
            const results = (r.result ?? []).map((ref: any) => resolve(ref?.reference)).filter(Boolean).map(observationLine);
            const specimen = resolve(r.specimen?.[0]?.reference);
            return [
                join([text(r.code) ?? "Report", text(r.category?.[0]), day(r.issued ?? r.effectiveDateTime)]),
                ...(specimen ? [`Specimen: ${join([text(specimen.type), day(specimen.collection?.collectedDateTime) && `collected ${day(specimen.collection?.collectedDateTime)}`], ", ")}`] : []),
                ...results,
                ...(r.conclusion ? [`Conclusion: ${r.conclusion}`] : []),
            ];
        }
        case "DocumentReference": {
            const attachment = r.content?.[0]?.attachment;
            return [join([r.description ?? attachment?.title ?? "Document", text(r.type), day(r.date ?? attachment?.creation)])];
        }
        case "Media":
            return [join([r.content?.title ?? "Image", r.content?.contentType])];
        case "Immunization":
            return [join([
                text(r.vaccineCode) ?? "Vaccine",
                r.protocolApplied?.[0]?.doseNumberPositiveInt ? `dose ${r.protocolApplied[0].doseNumberPositiveInt}` : null,
                day(r.occurrenceDateTime),
                r.manufacturer?.display ? `manufacturer ${r.manufacturer.display}` : null,
                r.lotNumber ? `lot ${r.lotNumber}` : null,
            ])];
        case "ImmunizationRecommendation":
            return (r.recommendation ?? []).map((rec: any) => join([
                rec.description ?? `Next dose of ${text(rec.vaccineCode?.[0]) ?? "vaccine"}`,
                rec.dateCriterion?.[0]?.value ? `due ${day(rec.dateCriterion[0].value)}` : null,
            ]));
        case "CarePlan":
            return [join([r.title, r.description], ": ") || "Care plan"];
        case "Appointment":
            return [join([r.description ?? text(r.serviceType?.[0]) ?? "Appointment", day(r.start)])];
        case "Invoice":
            return invoiceLines(r, resolve);
        case "ChargeItem":
            return [text(r.productCodeableConcept) ?? text(r.code) ?? "Charge"];
        case "Specimen":
            return [join([text(r.type) ?? "Specimen", day(r.collection?.collectedDateTime)])];
        // Listed under the record's files instead
        case "Binary":
        case "Patient":
        case "Practitioner":
        case "Organization":
        case "Encounter":
            return [];
        default:
            return [text(r?.code) ?? r?.resourceType ?? "Entry"];
    }
};

const base64Bytes = (data: unknown): number | null =>
    typeof data === "string" ? Math.max(0, Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)) : null;

/** Every file the bundle carries: document, report and image attachments, and Binary copies. */
const attachmentsOf = (bundle: FhirBundle, fallbackTitle: string): RecordViewAttachment[] => {
    const out: RecordViewAttachment[] = [];
    const add = (a: any, title?: string | null) => {
        if (!a) return;
        out.push({ title: a.title || title || fallbackTitle, contentType: a.contentType ?? null, bytes: typeof a.size === "number" ? a.size : base64Bytes(a.data) });
    };
    // An imaging report's image is both its Media and its presented form: one file
    const presented = new Set((bundle.entry as Array<{ resource: any }>).flatMap(({ resource: r }) =>
        r.resourceType === "DiagnosticReport" ? (r.presentedForm ?? []).map((a: any) => a.data) : []));
    for (const { resource: r } of bundle.entry as Array<{ resource: any }>) {
        if (r.resourceType === "DocumentReference") (r.content ?? []).forEach((c: any) => add(c.attachment, r.description));
        else if (r.resourceType === "DiagnosticReport") (r.presentedForm ?? []).forEach((a: any) => add(a, text(r.code)));
        else if (r.resourceType === "Media" && !presented.has(r.content?.data)) add(r.content);
        else if (r.resourceType === "Binary") add({ contentType: r.contentType, data: r.data }, `${fallbackTitle} (signed copy)`);
    }
    return out;
};

export const recordView = (record: { hiType: HiType; bundle: FhirBundle }): RecordView => {
    const { bundle } = record;
    const byUrl = new Map<string, FhirResource>();
    for (const e of bundle.entry) {
        byUrl.set(e.fullUrl, e.resource);
        byUrl.set(`${e.resource.resourceType}/${e.resource.id}`, e.resource);
    }
    const resolve: Resolve = (reference) => (typeof reference === "string" ? byUrl.get(reference) : undefined);
    const composition: any = bundle.entry.find((e) => e.resource.resourceType === "Composition")?.resource ?? {};
    const title = composition.title ?? record.hiType;

    const sections: RecordViewSection[] = [];
    const walk = (list: any[] | undefined) => {
        for (const s of list ?? []) {
            const items = (s.entry ?? []).flatMap((ref: any) => {
                const r = resolve(ref?.reference);
                return r ? lines(r, resolve) : [];
            });
            if (items.length) sections.push({ title: s.title ?? text(s.code) ?? "Section", items });
            walk(s.section);
        }
    };
    walk(composition.section);

    const author = resolve(composition.author?.[0]?.reference);
    return {
        hiType: record.hiType,
        title,
        date: composition.date ?? null,
        author: personName(author) ?? null,
        sections,
        attachments: attachmentsOf(bundle, title),
    };
};
