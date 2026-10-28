import { v5 as uuidv5 } from "uuid";
import { dosageOf } from "./dosage.js";
import type { OrganizationSource, PatientSource, PractitionerSource, CodedText, DocumentSource, MedicationSource } from "./fhir-sources.js";

/**
 * What every ABDM health record bundle shares: the NRCES DocumentBundle envelope, the Composition
 * that indexes it, and the patient, practitioner and facility it is about.
 * Profiles, fixed codes and code systems are NRCES IG 6.5.0 (nrces.in/ndhm/fhir/r4), checked
 * against its StructureDefinitions, ValueSets and CodeSystems on 2026-10-26.
 */

export type FhirResource = { resourceType: string; id: string; [key: string]: unknown };
export type FhirBundle = { resourceType: "Bundle"; id: string; entry: Array<{ fullUrl: string; resource: FhirResource }>; [key: string]: unknown };

/** The eight ABDM health information types, as the M2/M3 APIs spell them. */
export const HI_TYPES = [
    "OPConsultation",
    "Prescription",
    "DiagnosticReport",
    "DischargeSummary",
    "ImmunizationRecord",
    "HealthDocumentRecord",
    "WellnessRecord",
    "Invoice",
] as const;
export type HiType = (typeof HI_TYPES)[number];

export const NRCES = "https://nrces.in/ndhm/fhir/r4/StructureDefinition/";
export const SNOMED = "http://snomed.info/sct";
export const LOINC = "http://loinc.org";
export const UCUM = "http://unitsofmeasure.org";
const V2_0203 = "http://terminology.hl7.org/CodeSystem/v2-0203";
const NDHM_IDENTIFIER_TYPE = "https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code";

/**
 * Identifier namespaces this system mints. They are ClinicX's own, not NRCES's: NRCES prescribes
 * none for these, and identifiers are told apart by their type code.
 */
export const LOCAL_SYSTEM = "https://clinicx.yira.ai/fhir";

/** A record the data cannot make, such as a visit with nothing recorded. Nothing is sent for it. */
export class FhirSourceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FhirSourceError";
    }
}

// The same record always gets the same resource ids, so a rebuilt bundle is the same bundle.
const ID_NAMESPACE = "3f1d6a52-0c1e-4c8e-9a35-6b7e2f0d9c41";
export const resourceId = (kind: string, key: string | number): string => uuidv5(`${kind}:${key}`, ID_NAMESPACE);

export const ref = (resource: FhirResource, display?: string) => ({
    reference: `urn:uuid:${resource.id}`,
    ...(display ? { display } : {}),
});

/** What a person calls a resource: the words of its code, medicine, vaccine, file or title. */
export const displayOf = (r: FhirResource): string => {
    const x = r as any;
    const words = [x.code?.text, x.medicationCodeableConcept?.text, x.vaccineCode?.text, x.content?.[0]?.attachment?.title, x.type?.text, x.title,
        x.description, x.recommendation?.[0]?.description, x.code?.coding?.[0]?.display, r.resourceType].find((w) => typeof w === "string" && w.trim());
    return String(words).trim();
};

/**
 * A section entry, named: PHR apps list a section by its entries' display. Prescription,
 * DiagnosticReport, Immunization and Invoice slice their entries on type.
 */
export const entryRef = (resource: FhirResource) => ({ reference: `urn:uuid:${resource.id}`, type: resource.resourceType, display: displayOf(resource) });

const escapeHtml = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A plain sentence a person reads in their PHR app; the inputs are names and titles, so it is escaped. */
export const narrative = (text: string) => ({
    status: "generated",
    div: `<div xmlns="http://www.w3.org/1999/xhtml">${escapeHtml(text)}</div>`,
});

const pad = (n: number): string => String(Math.trunc(Math.abs(n))).padStart(2, "0");

const toDate = (value: Date | string): Date => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new FhirSourceError(`Not a date: ${String(value)}`);
    return date;
};

/** dateTime with the server's offset (+05:30 in production), as NRCES's examples carry it. */
export const fhirDateTime = (value: Date | string): string => {
    const d = toDate(value);
    const offset = -d.getTimezoneOffset();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
        + `${offset >= 0 ? "+" : "-"}${pad(offset / 60)}:${pad(offset % 60)}`;
};

export const fhirDate = (value: Date | string): string => {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = toDate(value);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** The shape of a SNOMED CT concept id. The clinic's pickers save typed words under made-up ids ("custom-…"). */
export const SNOMED_ID = /^\d{6,18}$/;

/** A SNOMED CT concept when the record carries one, its words always. Never a code the data lacks. */
export const concept = (item: CodedText | string, system = SNOMED) => {
    const text = (typeof item === "string" ? item : item.text).trim();
    const id = typeof item === "string" ? null : item.conceptId?.trim() || null;
    const code = id && (system !== SNOMED || SNOMED_ID.test(id)) ? id : null;
    return code ? { coding: [{ system, code, display: text }], text } : { text };
};

/**
 * Words and the concepts picked for them, as the clinic's chip fields store them: "Toothache, Fever"
 * with "27355003,386661006", one concept per chip, then any words typed after the chips. A made-up
 * id is dropped and its words kept; when the ids can't be paired with the words, the words go alone.
 */
export const codedText = (text?: string | null, conceptIds?: string | null): CodedText[] => {
    const words = text?.trim();
    if (!words) return [];
    const ids = (conceptIds ?? "").split(",").map((i) => i.trim()).filter(Boolean);
    if (ids.length <= 1) return [{ text: words, conceptId: ids[0] && SNOMED_ID.test(ids[0]) ? ids[0] : null }];
    const parts = words.split(", ").map((t) => t.trim()).filter(Boolean);
    if (ids.length > parts.length) return [{ text: words, conceptId: null }];
    const chips = ids.map((id, i) => ({ text: parts[i]!, conceptId: SNOMED_ID.test(id) ? id : null }));
    const typed = parts.slice(ids.length).join(", ");
    return typed ? [...chips, { text: typed, conceptId: null }] : chips;
};

const words = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();

/** The same concept: the same SNOMED CT id, or the same words. */
export const sameConcept = (a: CodedText, b: CodedText): boolean =>
    words(a.text) === words(b.text) || (Boolean(a.conceptId) && a.conceptId === b.conceptId);

/** Each concept once, the coded one kept when the same words come with and without a code. */
export const distinctCoded = <T extends CodedText>(items: T[]): T[] => {
    const out: T[] = [];
    for (const c of items) {
        const i = out.findIndex((o) => sameConcept(o, c));
        if (i < 0) out.push(c);
        else if (!out[i]!.conceptId && c.conceptId) out[i] = c;
    }
    return out;
};

/** Whether [text] already says [words], as whole words, ignoring case, spacing and punctuation: "Ice" is not in "Twice daily". */
export const mentions = (text: string | null | undefined, words: string | null | undefined): boolean => {
    const plain = (t: string | null | undefined) => ` ${(t ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
    return plain(words).trim() !== "" && plain(text).includes(plain(words));
};

/** "No", "nil", "none": the clinic recorded that there is nothing, which is not a finding called "no". */
export const isNegativeStatement = (text?: string | null): boolean =>
    /^(no|nil|nill|none|nothing|no history|no significant history|not significant|no complaints?)\.?$/i.test((text ?? "").trim());

const meta = (profile: string) => ({ profile: [NRCES + profile] });

const GENDERS: Record<string, string> = { male: "male", m: "male", female: "female", f: "female", other: "other", o: "other" };

export const patientResource = (p: PatientSource): FhirResource => {
    const identifier: unknown[] = [];
    if (p.abhaNumber) {
        // NRCES's examples carry the ABHA number as MR under healthid.ndhm.gov.in; its code system
        // names it HIN. No ABDM receiver has confirmed either, so both are carried.
        identifier.push(
            { type: { coding: [{ system: V2_0203, code: "MR", display: "Medical record number" }] }, system: "https://healthid.ndhm.gov.in", value: p.abhaNumber },
            { type: { coding: [{ system: NDHM_IDENTIFIER_TYPE, code: "HIN", display: "Health ID issued by NDHM" }] }, value: p.abhaNumber },
        );
    }
    if (p.abhaAddress) {
        identifier.push({ type: { coding: [{ system: NDHM_IDENTIFIER_TYPE, code: "ABHA", display: "Ayushman Bharat Health Account (ABHA) ID" }] }, value: p.abhaAddress });
    }
    identifier.push({ type: { coding: [{ system: V2_0203, code: "MR", display: "Medical record number" }] }, system: `${LOCAL_SYSTEM}/patient`, value: p.id });

    return {
        resourceType: "Patient",
        id: resourceId("Patient", p.id),
        meta: meta("Patient"),
        text: narrative(`Patient: ${p.name}`),
        identifier,
        name: [{ text: p.name }],
        ...(p.phone ? { telecom: [{ system: "phone", value: p.phone, use: "mobile" }] } : {}),
        gender: GENDERS[(p.gender ?? "").trim().toLowerCase()] ?? "unknown",
        ...(p.birthDate ? { birthDate: fhirDate(p.birthDate) } : {}),
    };
};

export const practitionerResource = (p: PractitionerSource): FhirResource => ({
    resourceType: "Practitioner",
    id: resourceId("Practitioner", p.id),
    meta: meta("Practitioner"),
    text: narrative(`Practitioner: ${p.name}`),
    identifier: [p.registrationNumber
        ? { type: { coding: [{ system: V2_0203, code: "MD", display: "Medical License number" }] }, system: `${LOCAL_SYSTEM}/medical-council-registration`, value: p.registrationNumber }
        : { type: { coding: [{ system: V2_0203, code: "EI", display: "Employee number" }] }, system: `${LOCAL_SYSTEM}/practitioner`, value: p.id }],
    name: [{ text: p.name }],
    ...(p.qualification ? { qualification: [{ code: { text: p.qualification } }] } : {}),
});

export const organizationResource = (o: OrganizationSource): FhirResource => ({
    resourceType: "Organization",
    id: resourceId("Organization", o.id),
    meta: meta("Organization"),
    text: narrative(`Facility: ${o.name}`),
    identifier: [o.hfrId
        ? { type: { coding: [{ system: V2_0203, code: "PRN", display: "Provider number" }] }, system: "https://facility.ndhm.gov.in", value: o.hfrId }
        : { type: { coding: [{ system: V2_0203, code: "PRN", display: "Provider number" }] }, system: `${LOCAL_SYSTEM}/hospital`, value: String(o.id) }],
    name: o.name,
    ...((o.phone || o.email) ? {
        telecom: [
            ...(o.phone ? [{ system: "phone", value: o.phone, use: "work" }] : []),
            ...(o.email ? [{ system: "email", value: o.email, use: "work" }] : []),
        ],
    } : {}),
});

// Where the patient went, most specific first: "discharged to rehab" is rehabilitation, not home
const DISPOSITIONS: Array<[RegExp, string, string]> = [
    [/against|\blama\b|\bdama\b/, "aadvice", "Left against advice"],
    [/expired|death|died|deceased/, "exp", "Expired"],
    [/rehab/, "rehab", "Rehabilitation"],
    [/skilled nursing|\bsnf\b|nursing (home|facility)/, "snf", "Skilled nursing facility"],
    [/psychiatr/, "psy", "Psychiatric hospital"],
    [/hospice/, "hosp", "Hospice"],
    [/long[- ]term care/, "long", "Long-term care"],
    [/transfer|refer|other (hospital|facility)/, "other-hcf", "Other healthcare facility"],
    [/\bhome\b|^discharged\.?$/, "home", "Home"],
];
const dispositionOf = (text: string) => {
    const known = DISPOSITIONS.find(([re]) => re.test(text.toLowerCase()));
    return known
        ? { coding: [{ system: "http://terminology.hl7.org/CodeSystem/discharge-disposition", code: known[1], display: known[2] }], text }
        : { text };
};

export const encounterResource = (e: {
    key: string;
    kind: "outpatient" | "virtual" | "inpatient";
    patient: FhirResource;
    start: Date;
    end?: Date | null;
    dischargeDisposition?: string | null;
    diagnoses?: FhirResource[];
}): FhirResource => {
    const cls = {
        outpatient: { code: "AMB", display: "ambulatory" },
        virtual: { code: "VR", display: "virtual" },
        inpatient: { code: "IMP", display: "inpatient encounter" },
    }[e.kind];
    return {
        resourceType: "Encounter",
        id: resourceId("Encounter", e.key),
        meta: meta("Encounter"),
        text: narrative(`${e.kind === "inpatient" ? "Hospital stay" : "Visit"} on ${fhirDate(e.start)}`),
        identifier: [{ system: `${LOCAL_SYSTEM}/encounter`, value: e.key }],
        status: "finished",
        class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", ...cls },
        subject: ref(e.patient, "Patient"),
        period: { start: fhirDateTime(e.start), ...(e.end ? { end: fhirDateTime(e.end) } : {}) },
        ...(e.diagnoses?.length ? {
            diagnosis: e.diagnoses.map((condition) => ({
                condition: ref(condition, "Condition"),
                use: { coding: [{ system: SNOMED, code: "39154008", display: "Clinical diagnosis" }] },
            })),
        } : {}),
        ...(e.dischargeDisposition ? { hospitalization: { dischargeDisposition: dispositionOf(e.dischargeDisposition) } } : {}),
    };
};

/** [recordedAt]: when the clinic recorded it, which a PHR app shows as "Recorded". */
export const conditionResource = (key: string, item: CodedText, patient: FhirResource, label: string, recordedAt: Date): FhirResource => ({
    resourceType: "Condition",
    id: resourceId("Condition", key),
    meta: meta("Condition"),
    text: narrative(`${label}: ${item.text}`),
    // What the clinician recorded is current: a complaint, a diagnosis or history on the record
    clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active", display: "Active" }] },
    code: concept(item),
    subject: ref(patient, "Patient"),
    recordedDate: fhirDateTime(recordedAt),
});

// "No allergies" as the SNOMED CT situations NRCES's own examples state it with; whole values only,
// so "no penicillin" stays an allergy to penicillin
const NO_ALLERGY = { code: "716186003", display: "No known allergy", text: "No known allergies" };
const NO_DRUG_ALLERGY = { code: "409137002", display: "No known drug allergy", text: "No known drug allergies" };
const allergyCode = (typed: string) => {
    const t = typed.trim().toLowerCase().replace(/\.$/, "");
    const none = /^(no|nil|nill|none|nka|no allerg(y|ies)|no known allerg(y|ies))$/.test(t) ? NO_ALLERGY
        : /^(nkda|no known drug allerg(y|ies)|no drug allerg(y|ies))$/.test(t) ? NO_DRUG_ALLERGY : null;
    return none ? { coding: [{ system: SNOMED, code: none.code, display: none.display }], text: none.text } : { text: typed };
};

export const allergyResource = (key: string, text: string, patient: FhirResource, recorder: FhirResource, recordedAt?: Date): FhirResource => ({
    resourceType: "AllergyIntolerance",
    id: resourceId("AllergyIntolerance", key),
    meta: meta("AllergyIntolerance"),
    text: narrative(`Allergies: ${text}`),
    // ait-1: clinicalStatus is required; allergies on the patient's record are current ones
    clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical", code: "active", display: "Active" }] },
    verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification", code: "confirmed", display: "Confirmed" }] },
    code: allergyCode(text),
    ...(recordedAt ? { recordedDate: fhirDateTime(recordedAt) } : {}),
    patient: ref(patient, "Patient"),
    recorder: ref(recorder, "Practitioner"),
});

/** An observation in words: an examination finding or a clinician's note. */
export const findingResource = (key: string, item: CodedText, patient: FhirResource, at: Date, label: string, note?: string, performer?: FhirResource): FhirResource => ({
    resourceType: "Observation",
    id: resourceId("Observation", key),
    meta: meta("Observation"),
    text: narrative(`${label}: ${note ?? item.text}`),
    status: "final",
    code: concept(item),
    subject: ref(patient, "Patient"),
    effectiveDateTime: fhirDateTime(at),
    ...(performer ? { performer: [ref(performer, "Practitioner")] } : {}),
    ...(note ? { valueString: note } : {}),
});

export const procedureResource = (key: string, item: CodedText, patient: FhirResource, at: Date): FhirResource => ({
    resourceType: "Procedure",
    id: resourceId("Procedure", key),
    meta: meta("Procedure"),
    text: narrative(`Procedure: ${item.text}`),
    status: "completed",
    code: concept(item),
    subject: ref(patient, "Patient"),
    performedDateTime: fhirDateTime(at),
});

export const medicationRequestResource = (
    m: MedicationSource,
    patient: FhirResource,
    requester: FhirResource,
    authoredOn: Date,
    reasons: FhirResource[] = [],
): FhirResource => {
    const dosage = dosageOf(m);
    return {
        resourceType: "MedicationRequest",
        id: resourceId("MedicationRequest", m.id),
        meta: meta("MedicationRequest"),
        text: narrative(`${m.name}: ${dosage.text}`),
        status: "active",
        intent: "order",
        medicationCodeableConcept: concept({ text: m.name, conceptId: m.conceptId }),
        subject: ref(patient, "Patient"),
        authoredOn: fhirDateTime(authoredOn),
        requester: ref(requester, "Practitioner"),
        // The diagnosis it treats, as words and code (which a PHR app shows) and as the Condition itself
        ...(reasons.length ? { reasonCode: reasons.map((r) => r.code), reasonReference: reasons.map((r) => ref(r, "Condition")) } : {}),
        // The prescription's own notes, unless the desk already wrote them into this medicine's advice
        ...(m.prescriptionNotes?.trim() && !isNegativeStatement(m.prescriptionNotes) && !mentions(m.instructions, m.prescriptionNotes) ? { note: [{ text: m.prescriptionNotes.trim() }] } : {}),
        // The sentence as written, with frequency, duration, dose and route as elements wherever the words are clear
        dosageInstruction: [dosage],
    };
};

/** A follow-up the doctor asked for. NRCES requires start; FHIR requires end with it, so end is the same instant. */
export const followUpAppointmentResource = (key: string, at: Date, patient: FhirResource, practitioner: FhirResource): FhirResource => ({
    resourceType: "Appointment",
    id: resourceId("Appointment", key),
    meta: meta("Appointment"),
    text: narrative(`Follow-up on ${fhirDate(at)}`),
    status: "proposed",
    // NRCES fixes the type's system to SNOMED CT; these are the codes its own example uses
    serviceType: [{ coding: [{ system: SNOMED, code: "11429006", display: "Consultation" }] }],
    appointmentType: { coding: [{ system: SNOMED, code: "185389009", display: "Follow-up visit" }] },
    description: "Follow-up visit",
    start: fhirDateTime(at),
    end: fhirDateTime(at),
    participant: [
        { actor: ref(patient, "Patient"), status: "needs-action" },
        { actor: ref(practitioner, "Practitioner"), status: "accepted" },
    ],
});

export const binaryResource = (key: string, contentType: string, data: Buffer): FhirResource => ({
    resourceType: "Binary",
    id: resourceId("Binary", key),
    meta: meta("Binary"),
    contentType,
    data: data.toString("base64"),
});

/** A file as a DocumentReference: the attachment is the record, so it is carried whole, base64. */
export const documentReferenceResource = (doc: DocumentSource, patient: FhirResource, type?: { code: string; display: string }): FhirResource => ({
    resourceType: "DocumentReference",
    id: resourceId("DocumentReference", doc.id),
    meta: meta("DocumentReference"),
    text: narrative(`${doc.title} (${doc.contentType})`),
    status: "current",
    docStatus: "final",
    type: { coding: [{ system: SNOMED, ...(type ?? { code: "419891008", display: "Record artifact" }) }], text: type ? type.display : doc.category || doc.title },
    subject: ref(patient, "Patient"),
    date: fhirDateTime(doc.createdAt),
    content: [{
        attachment: {
            contentType: doc.contentType,
            language: "en-IN",
            data: doc.data.toString("base64"),
            title: doc.title,
            creation: fhirDateTime(doc.createdAt),
        },
    }],
});

export interface CompositionInput {
    hiType: HiType;
    /** NRCES profile name, such as OPConsultRecord. */
    profile: string;
    /** Composition.type: the SNOMED code NRCES fixes, or text where it fixes text. */
    type: { coding?: { code: string; display: string }; text: string };
    title: string;
    /** Unique within the HI type: the record's own id. */
    key: string;
    date: Date;
    patient: FhirResource;
    author: FhirResource;
    custodian?: FhirResource;
    encounter?: FhirResource;
    sections: Array<Record<string, unknown>>;
    summary: string;
}

/**
 * The document bundle: Composition first, then every resource it or its entries reference, each once.
 * No attester or relatesTo: NRCES requires their children only when they are present, and nothing
 * here is attested or replaces an earlier document.
 */
export const documentBundle = (c: CompositionInput, resources: FhirResource[], now: Date = new Date()): FhirBundle => {
    if (c.sections.length === 0) throw new FhirSourceError(`Nothing to put in the ${c.hiType} record ${c.key}.`);

    const composition: FhirResource = {
        resourceType: "Composition",
        id: resourceId(`Composition:${c.hiType}`, c.key),
        meta: { versionId: "1", lastUpdated: fhirDateTime(now), profile: [NRCES + c.profile] },
        language: "en-IN",
        text: narrative(c.summary),
        identifier: { system: `${LOCAL_SYSTEM}/composition`, value: resourceId(`Composition:${c.hiType}`, c.key) },
        status: "final",
        type: c.type.coding ? { coding: [{ system: SNOMED, ...c.type.coding }], text: c.type.text } : { text: c.type.text },
        subject: ref(c.patient, "Patient"),
        ...(c.encounter ? { encounter: ref(c.encounter, "Encounter") } : {}),
        date: fhirDateTime(c.date),
        author: [ref(c.author, "Practitioner")],
        title: c.title,
        ...(c.custodian ? { custodian: ref(c.custodian, "Organization") } : {}),
        section: c.sections,
    };

    const seen = new Set<string>();
    const entries = [composition, c.patient, c.author, ...(c.custodian ? [c.custodian] : []), ...(c.encounter ? [c.encounter] : []), ...resources]
        .filter((r) => {
            if (seen.has(r.id)) return false;
            seen.add(r.id);
            return true;
        });

    const bundleId = resourceId(`Bundle:${c.hiType}`, c.key);
    return {
        resourceType: "Bundle",
        id: bundleId,
        meta: {
            versionId: "1",
            lastUpdated: fhirDateTime(now),
            profile: [NRCES + "DocumentBundle"],
            security: [{ system: "http://terminology.hl7.org/CodeSystem/v3-Confidentiality", code: "V", display: "very restricted" }],
        },
        identifier: { system: `${LOCAL_SYSTEM}/bundle`, value: bundleId },
        type: "document",
        timestamp: fhirDateTime(now),
        entry: entries.map((resource) => ({ fullUrl: `urn:uuid:${resource.id}`, resource })),
    };
};

/**
 * A Composition section; code is the SNOMED code NRCES fixes for the slice, where it fixes one, or
 * another system's for a section after the slices.
 */
export const section = (title: string, entries: FhirResource[], code?: { system?: string; code: string; display: string }, text?: string) => ({
    title,
    ...(code ? { code: { coding: [{ system: SNOMED, ...code }] } } : {}),
    ...(text ? { text: narrative(text) } : {}),
    ...(entries.length ? { entry: entries.map(entryRef) } : {}),
});
