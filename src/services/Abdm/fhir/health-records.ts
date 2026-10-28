import { createHash } from "node:crypto";
import {
    FhirSourceError, binaryResource, concept, conditionResource, documentBundle, documentReferenceResource, encounterResource,
    allergyResource, findingResource, fhirDate, fhirDateTime, followUpAppointmentResource, isNegativeStatement, medicationRequestResource, mentions,
    narrative, NRCES, organizationResource, patientResource, practitionerResource, procedureResource, ref, resourceId, sameConcept, section,
    LOCAL_SYSTEM, LOINC, SNOMED, UCUM, type FhirBundle, type FhirResource, type HiType,
} from "./fhir-common.js";
import { measurementObservation, sectionOf, visitVitalsToMeasurements, WELLNESS_PROFILES, type WellnessSection } from "./measurements.js";
import { routeOf } from "./dosage.js";
import type {
    CodedText, DiagnosticReportSource, DischargeSummarySource, ReportResultSource, HealthDocumentSource, ImmunizationSource, InvoiceSource,
    OpConsultationSource, PractitionerSource, PrescriptionSource, RecordParties, WellnessSource,
} from "./fhir-sources.js";

/**
 * One builder per ABDM HI type. Each takes ClinicX's own record and returns an NRCES document bundle.
 * The SNOMED codes on Composition.type and on each section are the ones the NRCES profile fixes
 * (StructureDefinitions, IG 6.5.0); clinical codes come only from what the clinic recorded.
 */

const parties = (s: RecordParties) => ({
    patient: patientResource(s.patient),
    practitioner: practitionerResource(s.practitioner),
    organization: organizationResource(s.organization),
});

/**
 * The encounter a record belongs to: its visit's, shared by every record of the visit, or else an
 * outpatient encounter of its own on the record's date. A PHR app shows the encounter's class under
 * the facility ("ambulatory"), and "NA" for a record without one.
 */
const encounterOf = (s: RecordParties, patient: FhirResource, key: string, at: Date): FhirResource =>
    s.visit
        ? encounterResource({ key: `appointment-${s.visit.id}`, kind: s.visit.teleconsultation ? "virtual" : "outpatient", patient, start: s.visit.start, end: s.visit.end })
        : encounterResource({ key, kind: "outpatient", patient, start: at });

/** The Conditions among [conditions] (built from [coded], in order) that are [items], each once. */
const conditionsFor = (items: CodedText[], coded: CodedText[], conditions: FhirResource[]): FhirResource[] =>
    [...new Set(items.map((c) => conditions[coded.findIndex((d) => sameConcept(d, c))]).filter((x): x is FhirResource => Boolean(x)))];

// OPConsultRecord section slices, discriminated on code.coding.code
const OP = {
    ChiefComplaints: { code: "422843007", display: "Chief complaint section" },
    PhysicalExamination: { code: "425044008", display: "Physical exam section" },
    Allergies: { code: "722446000", display: "Allergy record" },
    MedicalHistory: { code: "371529009", display: "History and physical report" },
    Medications: { code: "721912009", display: "Medication summary document" },
    FollowUp: { code: "390906007", display: "Follow-up encounter" },
    Procedure: { code: "371525003", display: "Clinical procedure report" },
    OtherObservations: { code: "404684003", display: "Clinical finding" },
    DocumentReference: { code: "371530004", display: "Clinical consultation report" },
    // Not a slice: the profile's sections are open at the end, and a diagnosis listed nowhere is one a PHR app never shows
    Diagnosis: { system: LOINC, code: "29548-5", display: "Diagnosis Narrative" },
};

/** OPConsultation: one outpatient visit (an appointment) and everything recorded at it. */
export const buildOpConsultation = (s: OpConsultationSource, now: Date = new Date()): FhirBundle => {
    const key = s.key ?? `appointment-${s.visit.id}`;
    const { patient, practitioner, organization } = parties(s);
    const at = s.vitalsRecordedAt ?? s.visit.start;
    const written = s.date ?? s.visit.start;

    const recorded = s.authoredOn ?? s.visit.start;
    const complaints = s.chiefComplaints.map((c, i) => conditionResource(`${key}:complaint:${i}`, c, patient, "Chief complaint", c.recordedAt ?? s.visit.start));
    const diagnoses = s.diagnoses.map((d, i) => conditionResource(`${key}:diagnosis:${i}`, d, patient, "Diagnosis", d.recordedAt ?? recorded));
    const encounter = encounterResource({
        key, kind: s.visit.teleconsultation ? "virtual" : "outpatient", patient, start: s.visit.start, end: s.visit.end, diagnoses,
    });
    // Every set of vitals of the visit; the first keeps the ids a single set always had
    const readings = s.vitalReadings ?? (s.vitals ? [{ vitals: s.vitals, at }] : []);
    const examination = [
        ...s.examinationFindings.filter((f) => !isNegativeStatement(f.text))
            .map((f, i) => findingResource(`${key}:exam:${i}`, f, patient, f.recordedAt ?? at, "Examination finding", undefined, practitioner)),
        ...readings.flatMap((r, j) => visitVitalsToMeasurements(r.vitals, r.at)
            .map((m, i) => measurementObservation(j === 0 ? `${key}:vital:${i}` : `${key}:vital:${j}:${i}`, m, patient, "Observation", practitioner))),
    ];
    const allergies = s.allergies?.trim() ? [allergyResource(`${key}:allergies`, s.allergies.trim(), patient, practitioner, s.visit.start)] : [];
    // "No history" is no history to list, not a condition called "no"
    const history = s.medicalHistory?.trim() && !isNegativeStatement(s.medicalHistory)
        ? [conditionResource(`${key}:history`, { text: s.medicalHistory.trim() }, patient, "Medical history", s.visit.start)]
        : [];

    // Each medicine is dated, prescribed and given its reasons by its own prescription
    const prescribers: FhirResource[] = [];
    const prescriberOf = (p?: PractitionerSource | null): FhirResource => {
        if (!p) return practitioner;
        const r = practitionerResource(p);
        if (r.id !== practitioner.id && !prescribers.some((x) => x.id === r.id)) prescribers.push(r);
        return r;
    };
    const medications = s.prescriptions
        ? s.prescriptions.flatMap((p) => {
            const by = prescriberOf(p.practitioner);
            const reasons = conditionsFor(p.diagnoses, s.diagnoses, diagnoses);
            return p.medications.map((m) => medicationRequestResource(m, patient, by, p.date, reasons));
        })
        : s.medications.map((m) => medicationRequestResource(m, patient, practitioner, s.authoredOn ?? s.visit.start, diagnoses));
    // A prescription's notes once, unless the desk already wrote them into each of its medicines' advice
    const prescriptionNotes = (s.prescriptions ?? [])
        .filter((p) => p.notes?.trim() && !isNegativeStatement(p.notes) && !(p.medications.length && p.medications.every((m) => mentions(m.instructions, p.notes))))
        .map((p, i) => findingResource(`${key}:prescription-note:${i}`, { text: "Prescription notes" }, patient, p.date, "Prescription notes", p.notes!.trim(), prescriberOf(p.practitioner)));
    const procedures = s.procedures.map((p, i) => procedureResource(`${key}:procedure:${i}`, p, patient, s.visit.start));
    // The form's "Treatment Plan" is what the doctor plans: an observation in words, not a procedure done
    const plans = (s.treatmentPlans ?? []).filter((t) => t.trim()).map((t, i) =>
        findingResource(`${key}:treatment-plan:${i}`, { text: "Treatment plan" }, patient, written, "Treatment plan", t.trim(), practitioner));
    const notes = s.notes.map((n, i) => ({ n, at: s.noteTimes?.[i] ?? s.visit.start })).filter(({ n }) => n.trim()).map(({ n, at: written }, i) =>
        findingResource(`${key}:note:${i}`, { text: "Clinical note" }, patient, written, "Clinical note", n.trim(), practitioner));
    const followUp = s.followUp ? [followUpAppointmentResource(`${key}:follow-up`, s.followUp, patient, practitioner)] : [];
    const documents = s.documents.map((d) => documentReferenceResource(d, patient));
    const others = [...plans, ...prescriptionNotes, ...notes];

    const sections = [
        complaints.length ? section("Chief complaints", complaints, OP.ChiefComplaints) : null,
        examination.length ? section("Physical examination", examination, OP.PhysicalExamination) : null,
        allergies.length ? section("Allergies", allergies, OP.Allergies) : null,
        history.length ? section("Medical history", history, OP.MedicalHistory) : null,
        medications.length ? section("Medications", medications, OP.Medications) : null,
        procedures.length ? section("Procedure", procedures, OP.Procedure) : null,
        followUp.length ? section("Follow up", followUp, OP.FollowUp) : null,
        others.length ? section("Other observations", others, OP.OtherObservations) : null,
        documents.length ? section("Document reference", documents, OP.DocumentReference) : null,
        diagnoses.length ? section("Diagnosis", diagnoses, OP.Diagnosis) : null,
    ].filter((x): x is NonNullable<typeof x> => x !== null);

    return documentBundle({
        hiType: "OPConsultation",
        profile: "OPConsultRecord",
        type: { coding: { code: "371530004", display: "Clinical consultation report" }, text: "Consultation report" },
        title: "Consultation report",
        key,
        date: written,
        patient, author: practitioner, custodian: organization, encounter,
        sections,
        summary: `Consultation of ${s.patient.name} with ${s.practitioner.name} at ${s.organization.name} on ${fhirDate(s.visit.start)}`,
    }, [...complaints, ...diagnoses, ...examination, ...allergies, ...history, ...medications, ...prescribers, ...procedures, ...followUp, ...others, ...documents], now);
};

/** Prescription: one prescription's medicines, with the PDF the clinic generated when there is one. */
export const buildPrescription = (s: PrescriptionSource, now: Date = new Date()): FhirBundle => {
    const p = s.prescription;
    const key = `prescription-${p.id}`;
    const { patient, practitioner, organization } = parties(s);
    if (p.medications.length === 0) throw new FhirSourceError(`Prescription ${p.id} has no medicines.`);

    const diagnoses = p.diagnoses.map((d, i) => conditionResource(`${key}:diagnosis:${i}`, d, patient, "Diagnosis", p.date));
    // The PHR app prints only each medicine's dosage line, so the prescription's notes go once at the end of
    // the last one (and as MedicationRequest.note for other readers), unless the desk wrote them into the
    // advice or they say "no". The app deletes every ".0" from that line, so a word joiner keeps "10.05" whole.
    const notes = isNegativeStatement(p.notes) ? null : p.notes?.trim();
    const unshown = notes && !p.medications.some((m) => mentions(m.instructions, notes)) ? notes : null;
    const medications = p.medications.map((m, i) => {
        const request = medicationRequestResource(m, patient, practitioner, p.date, diagnoses) as FhirResource & { dosageInstruction: Array<{ text: string }> };
        if (unshown && i === p.medications.length - 1) request.dosageInstruction[0]!.text += `. Notes: ${unshown.replace(/\.(?=0)/g, ".\u2060")}`;
        return request;
    });
    const encounter = encounterOf(s, patient, key, p.date);
    const signed = p.signedCopy ? [binaryResource(`${key}:pdf`, p.signedCopy.contentType, p.signedCopy.data)] : [];
    const record = { code: "440545006", display: "Prescription record" };

    return documentBundle({
        hiType: "Prescription",
        profile: "PrescriptionRecord",
        type: { coding: record, text: "Prescription record" },
        title: "Prescription record",
        key,
        date: p.date,
        patient, author: practitioner, custodian: organization, encounter,
        sections: [section("Prescription record", [...medications, ...signed], record)],
        summary: `Prescription for ${s.patient.name} by ${s.practitioner.name}, ${fhirDate(p.date)}: ${p.medications.map((m) => m.name).join(", ")}`,
    }, [...medications, ...signed, ...diagnoses], now);
};

/**
 * DiagnosticReport. A report entered at the clinic is a DiagnosticReportLab (its results as
 * Observations with value, unit, reference range and interpretation, the specimen, the conclusion,
 * and the report file as its presented form) or a DiagnosticReportImaging (the image as Media and
 * the conclusion). NRCES requires those, so the clinic's form does too before a report is Final.
 * A report the clinic holds only as an uploaded file goes in as a DocumentReference, which the
 * section allows on its own: a scanned report carries no results or conclusion to put in a
 * DiagnosticReport, so none is invented for it.
 */
const OBSERVATION_CATEGORY = "http://terminology.hl7.org/CodeSystem/observation-category";
const LOINC_CODE = /^\d{1,7}-\d$/;

const INTERPRETATIONS = {
    normal: { code: "N", display: "Normal" },
    high: { code: "H", display: "High" },
    low: { code: "L", display: "Low" },
    abnormal: { code: "A", display: "Abnormal" },
} as const;

/** One result of a report: its value with unit, the reference range, and whether it is normal, high or low. */
const resultObservation = (key: string, r: ReportResultSource, patient: FhirResource, at: Date, performer: FhirResource, performerName: string, lab: boolean, specimen?: FhirResource): FhirResource => {
    const valueWords = r.value !== null && r.value !== undefined ? `${r.value}${r.unit ? ` ${r.unit}` : ""}` : (r.valueText ?? "");
    const unit = r.unit ? { unit: r.unit } : {};
    const range = [r.low, r.high].some((v) => v !== null && v !== undefined) || r.referenceText ? [{
        ...(r.low !== null && r.low !== undefined ? { low: { value: r.low, ...unit } } : {}),
        ...(r.high !== null && r.high !== undefined ? { high: { value: r.high, ...unit } } : {}),
        ...(r.referenceText ? { text: r.referenceText } : {}),
    }] : null;
    return {
        resourceType: "Observation",
        id: resourceId("Observation", key),
        meta: { profile: [NRCES + "Observation"] },
        text: narrative(`${r.name.text}: ${valueWords}${r.interpretation && r.interpretation !== "normal" ? ` (${INTERPRETATIONS[r.interpretation].display})` : ""}`),
        status: "final",
        category: [{ coding: [{ system: OBSERVATION_CATEGORY, code: lab ? "laboratory" : "imaging", display: lab ? "Laboratory" : "Imaging" }] }],
        code: concept(r.name),
        subject: ref(patient, "Patient"),
        effectiveDateTime: fhirDateTime(at),
        performer: [ref(performer, performerName)],
        ...(r.value !== null && r.value !== undefined ? { valueQuantity: { value: r.value, ...unit } } : { valueString: r.valueText }),
        ...(r.interpretation ? {
            interpretation: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", ...INTERPRETATIONS[r.interpretation] }], text: INTERPRETATIONS[r.interpretation].display }],
        } : {}),
        ...(range ? { referenceRange: range } : {}),
        ...(specimen ? { specimen: ref(specimen, "Specimen") } : {}),
    };
};

export const buildDiagnosticReport = (s: DiagnosticReportSource, now: Date = new Date()): FhirBundle => {
    const e = s.entered ?? null;
    const doc = s.document ?? null;
    const { patient, practitioner, organization } = parties(s);
    const lab = s.kind === "lab";
    const studies = { code: "721981007", display: "Diagnostic studies report" };
    const title = lab ? "Laboratory report" : "Imaging report";

    if (!e) {
        if (!doc) throw new FhirSourceError("A diagnostic report needs its results or its file.");
        // 4241000179101 is the code NRCES's own examples type a laboratory report with.
        const file = documentReferenceResource(doc, patient, lab ? { code: "4241000179101", display: "Laboratory report" } : undefined);
        const fileKey = `report-${doc.id}`;
        return documentBundle({
            hiType: "DiagnosticReport",
            profile: "DiagnosticReportRecord",
            type: { coding: studies, text: title },
            title: `${title}: ${doc.title}`,
            key: fileKey,
            date: doc.createdAt,
            patient, author: practitioner, custodian: organization, encounter: encounterOf(s, patient, fileKey, doc.createdAt),
            sections: [section(title, [file], studies)],
            summary: `${title} for ${s.patient.name}: ${doc.title}, ${fhirDate(doc.createdAt)}`,
        }, [file], now);
    }

    const key = `diagnostic-report-${e.id}`;
    const conclusion = e.conclusion?.trim();
    if (!conclusion) throw new FhirSourceError(`Report ${e.id} has no conclusion.`);
    if (lab && !e.results.length) throw new FhirSourceError(`Lab report ${e.id} has no results.`);
    if (!lab && !doc) throw new FhirSourceError(`Imaging report ${e.id} has no image.`);
    const effective = e.collectedAt ?? e.issuedAt;

    // The lab received the specimen it collected: NRCES requires both times, and the clinic records one
    const specimen: FhirResource[] = lab && e.specimen && e.collectedAt ? [{
        resourceType: "Specimen",
        id: resourceId("Specimen", key),
        meta: { profile: [NRCES + "Specimen"] },
        text: narrative(`Specimen: ${e.specimen.text}`),
        type: concept(e.specimen),
        subject: ref(patient, "Patient"),
        receivedTime: fhirDateTime(e.collectedAt),
        collection: { collectedDateTime: fhirDateTime(e.collectedAt) },
    }] : [];
    const results = e.results.map((r) => resultObservation(`${key}:result:${r.id}`, r, patient, effective, practitioner, s.practitioner.name, lab, specimen[0]));
    const media: FhirResource[] = !lab && doc ? [{
        resourceType: "Media",
        id: resourceId("Media", key),
        meta: { profile: [NRCES + "Media"] },
        text: narrative(`Image: ${doc.title}`),
        status: "completed",
        subject: ref(patient, "Patient"),
        ...(e.collectedAt ? { createdDateTime: fhirDateTime(e.collectedAt) } : {}),
        content: { contentType: doc.contentType, language: "en-IN", data: doc.data.toString("base64"), title: doc.title, creation: fhirDateTime(doc.createdAt) },
    }] : [];
    const report: FhirResource = {
        resourceType: "DiagnosticReport",
        id: resourceId("DiagnosticReport", key),
        meta: { profile: [NRCES + (lab ? "DiagnosticReportLab" : "DiagnosticReportImaging")] },
        text: narrative(`${title}: ${e.test.text}. ${conclusion}`),
        status: "final",
        // NRCES fixes the category to SNOMED CT diagnostic services and its examples name one service each
        // (haematology, CT); a report's own service isn't recorded, so the category is said in words.
        category: [{ text: lab ? "Laboratory" : "Imaging" }],
        // NRCES fixes the test's code to LOINC: a LOINC code is sent as one, a SNOMED CT pick as the test's words
        code: LOINC_CODE.test(e.test.conceptId ?? "")
            ? { coding: [{ system: LOINC, code: e.test.conceptId, display: e.test.text }], text: e.test.text }
            : { text: e.test.text },
        subject: ref(patient, "Patient"),
        effectiveDateTime: fhirDateTime(effective),
        issued: fhirDateTime(e.issuedAt),
        performer: [ref(organization, s.organization.name), ...(e.performedBy?.trim() ? [{ display: e.performedBy.trim() }] : [])],
        resultsInterpreter: [ref(practitioner, s.practitioner.name)],
        ...(specimen.length ? { specimen: specimen.map((x) => ref(x, "Specimen")) } : {}),
        ...(results.length ? { result: results.map((o) => ref(o, "Observation")) } : {}),
        ...(media.length ? { media: media.map((m) => ({ comment: doc!.title, link: ref(m, "Media") })) } : {}),
        conclusion,
        ...(e.conclusionCodes.length ? { conclusionCode: e.conclusionCodes.map((c) => concept(c)) } : {}),
        // The file as issued, which is what a PHR app lists and opens: an imaging report's image too, besides its Media
        ...(doc ? {
            presentedForm: [{ contentType: doc.contentType, language: "en-IN", data: doc.data.toString("base64"), title: doc.title, creation: fhirDateTime(doc.createdAt) }],
        } : {}),
    };

    return documentBundle({
        hiType: "DiagnosticReport",
        profile: "DiagnosticReportRecord",
        type: { coding: studies, text: title },
        title: `${title}: ${e.test.text}`,
        key,
        date: e.issuedAt,
        patient, author: practitioner, custodian: organization, encounter: encounterOf(s, patient, key, effective),
        sections: [section(title, [report], studies)],
        summary: `${title} for ${s.patient.name}: ${e.test.text}, ${fhirDate(e.issuedAt)}`,
    }, [report, ...results, ...specimen, ...media], now);
};

/** HealthDocumentRecord: documents the clinic holds that are not a lab, imaging or prescription record. */
export const buildHealthDocumentRecord = (s: HealthDocumentSource, now: Date = new Date()): FhirBundle => {
    const { patient, practitioner, organization } = parties(s);
    if (s.documents.length === 0) throw new FhirSourceError(`No documents for ${s.key}.`);
    const artifact = { code: "419891008", display: "Record artifact" };
    // The same file saved twice (an upload and the copy sent to the patient) is listed once, as the first
    const seen = new Set<string>();
    const files = s.documents.filter((d) => {
        if (!d.data.length) return true;
        const hash = createHash("sha256").update(d.data).digest("hex");
        if (seen.has(hash)) return false;
        seen.add(hash);
        return true;
    }).map((d) => documentReferenceResource(d, patient));

    return documentBundle({
        hiType: "HealthDocumentRecord",
        profile: "HealthDocumentRecord",
        type: { coding: artifact, text: "Health document" },
        title: s.title,
        key: s.key,
        date: s.date,
        patient, author: practitioner, custodian: organization, encounter: encounterOf(s, patient, s.key, s.date),
        sections: [section("Health Document", files, artifact)],
        summary: `${s.title} for ${s.patient.name}: ${s.documents.map((d) => d.title).join(", ")}`,
    }, files, now);
};

// WellnessRecord section slices, discriminated on title
const WELLNESS_TITLES: Record<WellnessSection, string> = {
    VitalSigns: "Vital Signs",
    BodyMeasurement: "Body Measurement",
    PhysicalActivity: "Physical Activity",
    GeneralAssessment: "General Assessment",
};

/** WellnessRecord: vitals and activity, from a vitals check at the clinic or the patient's health app. */
export const buildWellnessRecord = (s: WellnessSource, now: Date = new Date()): FhirBundle => {
    const { patient, practitioner, organization } = parties(s);
    const bySection = new Map<WellnessSection, FhirResource[]>();
    s.measurements.forEach((m, i) => {
        const name = sectionOf(m);
        const observation = measurementObservation(`${s.key}:${i}`, m, patient, WELLNESS_PROFILES[name], practitioner);
        bySection.set(name, [...(bySection.get(name) ?? []), observation]);
    });
    const order: WellnessSection[] = ["VitalSigns", "BodyMeasurement", "PhysicalActivity", "GeneralAssessment"];
    // The note goes in the slice WellnessRecord titles "Other Observations"
    const note = s.notes?.trim() ? [findingResource(`${s.key}:note`, { text: "Wellness note" }, patient, s.date, "Note", s.notes.trim(), practitioner)] : [];
    const sections = [
        ...order.filter((name) => bySection.has(name)).map((name) => section(WELLNESS_TITLES[name], bySection.get(name)!)),
        ...(note.length ? [section("Other Observations", note)] : []),
    ];

    return documentBundle({
        hiType: "WellnessRecord",
        profile: "WellnessRecord",
        type: { text: "Wellness Record" },
        title: "Wellness Record",
        key: s.key,
        date: s.date,
        patient, author: practitioner, custodian: organization, encounter: encounterOf(s, patient, s.key, s.date),
        sections,
        summary: `Wellness record for ${s.patient.name}, ${fhirDate(s.date)}`,
    }, [...[...bySection.values()].flat(), ...note], now);
};

const BILLING = "https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-billing-codes";
const PRICE = "https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-price-components";
/**
 * ndhm-price-components (IG 6.5.0) has MRP, Rate, Discount, CGST and SGST, and no IGST. The binding is
 * extensible and a price component needs one coding with system, code and display, so IGST is coded
 * in Clinicx's own system.
 */
const IGST = { system: `${LOCAL_SYSTEM}/price-components`, code: "IGST", display: "IGST" };
// ndhm-billing-codes (IG 6.5.0): 00 Consultation, 03 OPD, 99 Others
const billingCode = (itemType: string) =>
    itemType === "Consultation" ? { code: "00", display: "Consultation" }
        : itemType === "TreatmentPlan" ? { code: "03", display: "OPD" }
            : { code: "99", display: "Others" };
const money = (value: number) => ({ value: Math.round(value * 100) / 100, currency: "INR" });
const paise = (value: number) => Math.round(value * 100) / 100;
const INVOICE_STATUS: Record<string, string> = { Pending: "issued", PartiallyPaid: "issued", Paid: "balanced" };

/** [total] in shares by [weights], to the paisa, the rounding left on the largest share so they add up to it. */
const shares = (total: number, weights: number[]): number[] => {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!total || sum <= 0) return weights.map(() => 0);
    const out = weights.map((w) => paise((total * w) / sum));
    const largest = weights.indexOf(Math.max(...weights));
    out[largest] = paise(out[largest]! + total - out.reduce((a, b) => a + b, 0));
    return out;
};

const PRICE_CODES = {
    rate: { system: PRICE, code: "01", display: "Rate" },
    discount: { system: PRICE, code: "02", display: "Discount" },
    cgst: { system: PRICE, code: "03", display: "CGST" },
    sgst: { system: PRICE, code: "04", display: "SGST" },
};

/**
 * Invoice: an issued appointment bill. A draft bill is not an invoice yet and is not shared, nor is
 * one still numbered DFT-, which the clinic has not issued. The ABHA app prints each line's price
 * components and then the totals, so the lines carry the bill as charged: the concession and the GST
 * the bill applied, shared over the lines, so that they add up to the total. GST is CGST and SGST
 * unless the bill charged IGST alone.
 */
export const buildInvoice = (s: InvoiceSource, now: Date = new Date()): FhirBundle => {
    const b = s.bill;
    const status = INVOICE_STATUS[b.status];
    if (!status) throw new FhirSourceError(`Bill ${b.number} is ${b.status}, not issued.`);
    if (!b.number || b.number.startsWith("DFT-")) throw new FhirSourceError(`Bill ${b.id} has no invoice number yet.`);
    if (b.items.length === 0) throw new FhirSourceError(`Bill ${b.number} has no items.`);
    const key = `bill-${b.id}`;
    const { patient, practitioner, organization } = parties(s);

    const base = b.items.map((item) => paise(item.unitPrice * item.quantity));
    const taxable = b.items.map((item, i) => Math.max(0, base[i]! - item.discount));
    // A concession on the whole bill, beyond the items' own discounts, shared by what each line costs
    const concession = Math.min(Math.max(0, paise(b.discount - b.items.reduce((a, i) => a + i.discount, 0))), taxable.reduce((a, t) => a + t, 0));
    const concessionShares = shares(concession, taxable);
    // The GST the bill charged, shared by each line's own GST (or its price when no line has any)
    const itemGst = b.items.map((i) => i.gstAmount);
    const charged = (b.gst ?? 0) > 0 ? b.gst! : b.cgst + b.sgst + b.igst > 0 ? paise(b.cgst + b.sgst + b.igst) : paise(itemGst.reduce((a, g) => a + g, 0));
    const weights = itemGst.some((g) => g > 0) ? itemGst : taxable;
    const igstOnly = b.igst > 0 && b.cgst <= 0 && b.sgst <= 0;
    const cgstTotal = igstOnly ? 0 : paise(charged / 2);
    const [igstShares, cgstShares, sgstShares] = [shares(igstOnly ? charged : 0, weights), shares(cgstTotal, weights), shares(igstOnly ? 0 : paise(charged - cgstTotal), weights)];

    const charges = b.items.map((item) => ({
        resourceType: "ChargeItem",
        id: resourceId("ChargeItem", item.id),
        meta: { profile: [NRCES + "ChargeItem"] },
        text: narrative(`${item.name} x ${item.quantity}`),
        status: "billed",
        code: { coding: [{ system: BILLING, ...billingCode(item.type) }] },
        subject: ref(patient, "Patient"),
        performer: [{ actor: ref(practitioner, "Practitioner") }],
        quantity: { value: item.quantity, unit: item.quantity === 1 ? "unit" : "units", system: UCUM, code: "1" },
        productCodeableConcept: { text: item.name },
    } as FhirResource));

    const component = (type: string, code: object, amount: number, text?: string) => ({ type, code: { coding: [code], ...(text ? { text } : {}) }, amount: money(amount) });
    const lineItem = b.items.map((item, i) => {
        const discount = paise(item.discount + concessionShares[i]!);
        return {
            sequence: i + 1,
            chargeItemReference: ref(charges[i]!, "ChargeItem"),
            priceComponent: [
                component("base", PRICE_CODES.rate, base[i]!),
                ...(discount > 0 ? [component("discount", PRICE_CODES.discount, discount)] : []),
                ...(cgstShares[i]! > 0 ? [component("tax", PRICE_CODES.cgst, cgstShares[i]!)] : []),
                ...(sgstShares[i]! > 0 ? [component("tax", PRICE_CODES.sgst, sgstShares[i]!)] : []),
                ...(igstShares[i]! > 0 ? [component("tax", IGST, igstShares[i]!, "IGST")] : []),
            ],
        };
    });

    const allConsultation = b.items.every((i) => i.type === "Consultation");
    const invoice: FhirResource = {
        resourceType: "Invoice",
        id: resourceId("Invoice", b.id),
        meta: { profile: [NRCES + "Invoice"] },
        text: narrative(`Invoice ${b.number}: INR ${b.total}`),
        identifier: [{ system: "https://clinicx.yira.ai/fhir/invoice", value: b.number }],
        status,
        type: { coding: [{ system: BILLING, ...(allConsultation ? { code: "00", display: "Consultation" } : { code: "03", display: "OPD" }) }] },
        subject: ref(patient, "Patient"),
        date: fhirDateTime(b.date),
        participant: [{ actor: ref(practitioner, "Practitioner") }],
        issuer: ref(organization, "Organization"),
        lineItem,
        // The bill's own concession and GST, as the clinic's printed invoice states them
        totalPriceComponent: [
            ...(concession > 0 ? [component("discount", PRICE_CODES.discount, concession, "General concession")] : []),
            ...(igstOnly ? [component("tax", IGST, charged, "IGST")] : charged > 0 ? [component("tax", PRICE_CODES.cgst, cgstTotal), component("tax", PRICE_CODES.sgst, paise(charged - cgstTotal))] : []),
        ],
        totalNet: money(b.total - charged),
        totalGross: money(b.total),
    };
    if (!(invoice.totalPriceComponent as unknown[]).length) delete invoice.totalPriceComponent;

    return documentBundle({
        hiType: "Invoice",
        profile: "InvoiceRecord",
        type: { text: "Invoice Record" },
        title: `Invoice ${b.number}`,
        key,
        date: b.date,
        patient, author: practitioner, custodian: organization, encounter: encounterOf(s, patient, key, b.date),
        sections: [section("Invoice", [invoice])],
        summary: `Invoice ${b.number} for ${s.patient.name} from ${s.organization.name}, INR ${b.total}`,
    }, [invoice, ...charges], now);
};

// Injection sites as FHIR's immunization-site codes (HL7 v3 ActSite), for the sites the clinic's form offers
const SITES: Array<[RegExp, string, string]> = [
    [/left deltoid/, "LD", "left deltoid"], [/right deltoid/, "RD", "right deltoid"],
    [/left thigh/, "LT", "left thigh"], [/right thigh/, "RT", "right thigh"],
    [/left upper arm/, "LUA", "left upper arm"], [/right upper arm/, "RUA", "right upper arm"],
];
const siteOf = (site: string) => {
    const known = SITES.find(([re]) => re.test(site.toLowerCase()));
    return known ? { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ActSite", code: known[1], display: known[2] }], text: site } : { text: site };
};

/** ImmunizationRecord: the vaccines given, the next dose due, and the certificates uploaded for them. */
export const buildImmunizationRecord = (s: ImmunizationSource, now: Date = new Date()): FhirBundle => {
    if (s.immunizations.length === 0) throw new FhirSourceError(`No immunizations for ${s.key}.`);
    const { patient, practitioner, organization } = parties(s);
    const record = { code: "41000179103", display: "Immunization record" };

    const givers: FhirResource[] = [];
    const immunizations = s.immunizations.map((im) => ({
        resourceType: "Immunization",
        id: resourceId("Immunization", im.id),
        meta: { profile: [NRCES + "Immunization"] },
        text: narrative(`${im.vaccine.text}${im.doseNumber ? `, dose ${im.doseNumber}` : ""}, given ${fhirDate(im.date)}`),
        status: "completed",
        vaccineCode: concept(im.vaccine),
        patient: ref(patient, "Patient"),
        occurrenceDateTime: typeof im.date === "string" ? fhirDate(im.date) : fhirDateTime(im.date),
        primarySource: true,
        // The maker as the clinic typed it, which a PHR app prints as "Manufacturer"
        ...(im.manufacturer?.trim() ? { manufacturer: { display: im.manufacturer.trim() } } : {}),
        ...(im.lotNumber ? { lotNumber: im.lotNumber } : {}),
        ...(im.site ? { site: siteOf(im.site) } : {}),
        ...(im.route ? { route: routeOf(im.route) } : {}),
        // Who gave it, when the clinic recorded that; never the record's author by default
        ...(im.performer ? {
            performer: [{
                function: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0443", code: "AP", display: "Administering Provider" }] },
                actor: ref(((r) => (givers.some((g) => g.id === r.id) ? r : (givers.push(r), r)))(practitionerResource(im.performer)), "Practitioner"),
            }],
        } : {}),
        ...(im.notes?.trim() ? { note: [{ text: im.notes.trim() }] } : {}),
        ...(im.doseNumber ? { protocolApplied: [{ doseNumberPositiveInt: im.doseNumber }] } : {}),
    } as FhirResource));

    const due = s.immunizations.filter((im) => im.nextDueDate);
    const recommendation: FhirResource[] = due.length ? [{
        resourceType: "ImmunizationRecommendation",
        id: resourceId("ImmunizationRecommendation", s.key),
        meta: { profile: [NRCES + "ImmunizationRecommendation"] },
        text: narrative(`Next doses due: ${due.map((im) => `${im.vaccine.text} on ${fhirDate(im.nextDueDate!)}`).join(", ")}`),
        patient: ref(patient, "Patient"),
        date: fhirDateTime(s.date),
        authority: ref(organization, "Organization"),
        recommendation: due.map((im) => ({
            vaccineCode: [concept(im.vaccine)],
            supportingImmunization: [ref(immunizations[s.immunizations.indexOf(im)]!, "Immunization")],
            description: `Next dose of ${im.vaccine.text}`,
            ...(im.doseNumber ? { doseNumberPositiveInt: im.doseNumber + 1 } : {}),
            forecastStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/immunization-recommendation-status", code: "due", display: "Due" }] },
            dateCriterion: [{
                code: { coding: [{ system: LOINC, code: "30980-7", display: "Date vaccine due" }] },
                value: fhirDate(im.nextDueDate!),
            }],
        })),
    }] : [];
    const certificates = (s.certificates ?? []).map((c) => documentReferenceResource(c, patient));

    return documentBundle({
        hiType: "ImmunizationRecord",
        profile: "ImmunizationRecord",
        type: { coding: record, text: "Immunization record" },
        title: "Immunization record",
        key: s.key,
        date: s.date,
        patient, author: practitioner, custodian: organization, encounter: encounterOf(s, patient, s.key, s.date),
        sections: [section("Immunization record", [...immunizations, ...recommendation, ...certificates], record)],
        summary: `Immunization record for ${s.patient.name}: ${s.immunizations.map((im) => im.vaccine.text).join(", ")}`,
    }, [...immunizations, ...givers, ...recommendation, ...certificates], now);
};

// DischargeSummaryRecord section slices, discriminated on code.coding.code
const DS = {
    ChiefComplaints: { code: "422843007", display: "Chief complaint section" },
    PhysicalExamination: { code: "425044008", display: "Physical exam section" },
    Allergies: { code: "722446000", display: "Allergy record" },
    MedicalHistory: { code: "1003642006", display: "Past medical history section" },
    Medications: { code: "1003606003", display: "Medication history section" },
    Procedures: { code: "1003640003", display: "History of past procedure section" },
    CarePlan: { code: "734163000", display: "Care plan" },
    DocumentReference: { code: "373942005", display: "Discharge summary" },
    // Not slices: after them, as the profile's open-at-end sections allow
    Diagnoses: { system: LOINC, code: "11535-2", display: "Hospital discharge Dx Narrative" },
    InvestigationsNarrative: { system: LOINC, code: "30954-2", display: "Relevant diagnostic tests/laboratory data Narrative" },
};

/** DischargeSummary: one hospital stay, written up when the patient leaves. */
export const buildDischargeSummary = (s: DischargeSummarySource, now: Date = new Date()): FhirBundle => {
    const d = s.summary;
    const key = `discharge-${d.id}`;
    const { patient, practitioner, organization } = parties(s);

    // Complaints and history are taken on admission; the diagnoses are the ones the stay ended with
    const complaints = d.chiefComplaints.map((c, i) => conditionResource(`${key}:complaint:${i}`, c, patient, "Chief complaint", d.admittedAt));
    const diagnoses = d.diagnoses.map((c, i) => conditionResource(`${key}:diagnosis:${i}`, c, patient, "Diagnosis", d.dischargedAt));
    const history = d.medicalHistory.filter((c) => !isNegativeStatement(c.text)).map((c, i) => conditionResource(`${key}:history:${i}`, c, patient, "Medical history", d.admittedAt));
    const encounter = encounterResource({
        key, kind: "inpatient", patient, start: d.admittedAt, end: d.dischargedAt, diagnoses, dischargeDisposition: d.disposition,
    });
    // "No" in a list is nothing found, not a finding or a condition called "no"
    const examination = d.examinationFindings.filter((f) => !isNegativeStatement(f.text))
        .map((f, i) => findingResource(`${key}:exam:${i}`, f, patient, d.admittedAt, "Examination finding", undefined, practitioner));
    const allergies = d.allergies?.trim() ? [allergyResource(`${key}:allergies`, d.allergies.trim(), patient, practitioner, d.admittedAt)] : [];
    const procedures = d.procedures.map((p, i) => procedureResource(`${key}:procedure:${i}`, p, patient, d.admittedAt));
    // The medicines treat the stay's diagnoses, or, when the summary names none, their prescription's
    const reasons = diagnoses.length || !d.medications.length ? diagnoses
        : (d.prescriptionDiagnoses ?? []).map((c, i) => conditionResource(`${key}:prescription-diagnosis:${i}`, c, patient, "Diagnosis", d.dischargedAt));
    const medications = d.medications.map((m) => medicationRequestResource(m, patient, practitioner, d.dischargedAt, reasons));
    // Investigations are typed as text: an observation in words, after the slices, whose entries must be full reports
    const investigations: FhirResource[] = d.investigations?.trim() ? [{
        resourceType: "Observation",
        id: resourceId("Observation", `${key}:investigations`),
        meta: { profile: [NRCES + "Observation"] },
        text: narrative(`Investigations: ${d.investigations.trim()}`),
        status: "final",
        code: { coding: [{ system: LOINC, code: DS.InvestigationsNarrative.code, display: DS.InvestigationsNarrative.display }], text: "Investigations" },
        subject: ref(patient, "Patient"),
        // The clinic records no test date: they were done during the stay
        effectivePeriod: { start: fhirDateTime(d.admittedAt), end: fhirDateTime(d.dischargedAt) },
        performer: [ref(practitioner, "Practitioner")],
        valueString: d.investigations.trim(),
    }] : [];
    // The follow-up as the appointment a PHR app shows under the care plan, with its date
    const followUp = d.followUp ? [followUpAppointmentResource(`${key}:follow-up`, d.followUp, patient, practitioner)] : [];
    const planText = [d.carePlan?.trim(), d.followUp ? `Follow up on ${fhirDate(d.followUp)}.` : null].filter(Boolean).join(" ");
    const carePlan: FhirResource[] = planText ? [{
        resourceType: "CarePlan",
        id: resourceId("CarePlan", key),
        meta: { profile: [NRCES + "CarePlan"] },
        text: narrative(planText),
        status: "active",
        intent: "plan",
        category: [{ coding: [{ system: SNOMED, code: "736353004", display: "Inpatient care plan" }], text: "Discharge care plan" }],
        title: "Discharge care plan",
        description: planText,
        subject: ref(patient, "Patient"),
        // From discharge on; a follow-up on the discharge day would end it before it starts (per-1)
        period: { start: fhirDateTime(d.dischargedAt) },
        author: ref(practitioner, "Practitioner"),
        ...(followUp.length ? { activity: [{ outcomeReference: [ref(followUp[0]!, "Appointment")] }] } : {}),
    }] : [];
    const document = s.document ? [documentReferenceResource(s.document, patient, DS.DocumentReference)] : [];

    const sections = [
        complaints.length ? section("Chief complaints", complaints, DS.ChiefComplaints) : null,
        examination.length ? section("Physical examination", examination, DS.PhysicalExamination) : null,
        allergies.length ? section("Allergies", allergies, DS.Allergies) : null,
        history.length ? section("Medical history", history, DS.MedicalHistory) : null,
        procedures.length ? section("Procedures", procedures, DS.Procedures) : null,
        medications.length ? section("Medications", medications, DS.Medications) : null,
        carePlan.length ? section("Care plan", carePlan, DS.CarePlan) : null,
        document.length ? section("Document reference", document, DS.DocumentReference) : null,
        investigations.length ? section("Investigations", investigations, DS.InvestigationsNarrative) : null,
        diagnoses.length ? section("Discharge diagnosis", diagnoses, DS.Diagnoses) : null,
    ].filter((x): x is NonNullable<typeof x> => x !== null);

    return documentBundle({
        hiType: "DischargeSummary",
        profile: "DischargeSummaryRecord",
        type: { coding: { code: "373942005", display: "Discharge summary" }, text: "Discharge summary" },
        title: "Discharge summary",
        key,
        date: d.dischargedAt,
        patient, author: practitioner, custodian: organization, encounter,
        sections,
        summary: `Discharge summary for ${s.patient.name}, admitted ${fhirDate(d.admittedAt)}, discharged ${fhirDate(d.dischargedAt)}`,
    }, [...complaints, ...diagnoses, ...(reasons === diagnoses ? [] : reasons), ...history, ...examination, ...allergies, ...procedures, ...medications,
        ...investigations, ...carePlan, ...followUp, ...document], now);
};

export type RecordSourceFor = {
    OPConsultation: OpConsultationSource;
    Prescription: PrescriptionSource;
    DiagnosticReport: DiagnosticReportSource;
    DischargeSummary: DischargeSummarySource;
    ImmunizationRecord: ImmunizationSource;
    HealthDocumentRecord: HealthDocumentSource;
    WellnessRecord: WellnessSource;
    Invoice: InvoiceSource;
};

export const BUILDERS: { [T in HiType]: (source: RecordSourceFor[T], now?: Date) => FhirBundle } = {
    OPConsultation: buildOpConsultation,
    Prescription: buildPrescription,
    DiagnosticReport: buildDiagnosticReport,
    DischargeSummary: buildDischargeSummary,
    ImmunizationRecord: buildImmunizationRecord,
    HealthDocumentRecord: buildHealthDocumentRecord,
    WellnessRecord: buildWellnessRecord,
    Invoice: buildInvoice,
};
