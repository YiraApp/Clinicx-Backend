import {
    FhirSourceError, binaryResource, concept, conditionResource, documentBundle, documentReferenceResource, encounterResource,
    allergyResource, findingResource, fhirDate, fhirDateTime, followUpAppointmentResource, medicationRequestResource,
    narrative, NRCES, organizationResource, patientResource, practitionerResource, procedureResource, ref, resourceId, section,
    LOINC, type FhirBundle, type FhirResource, type HiType,
} from "./fhir-common.js";
import { measurementObservation, sectionOf, visitVitalsToMeasurements, WELLNESS_PROFILES, type WellnessSection } from "./measurements.js";
import type {
    DiagnosticReportSource, DischargeSummarySource, HealthDocumentSource, ImmunizationSource, InvoiceSource,
    OpConsultationSource, PrescriptionSource, RecordParties, WellnessSource,
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
};

/** OPConsultation: one outpatient visit (an appointment) and everything recorded at it. */
export const buildOpConsultation = (s: OpConsultationSource, now: Date = new Date()): FhirBundle => {
    const key = `appointment-${s.visit.id}`;
    const { patient, practitioner, organization } = parties(s);
    const at = s.vitalsRecordedAt ?? s.visit.start;

    const complaints = s.chiefComplaints.map((c, i) => conditionResource(`${key}:complaint:${i}`, c, patient, "Chief complaint"));
    const diagnoses = s.diagnoses.map((d, i) => conditionResource(`${key}:diagnosis:${i}`, d, patient, "Diagnosis"));
    const encounter = encounterResource({
        key, kind: s.visit.teleconsultation ? "virtual" : "outpatient", patient, start: s.visit.start, end: s.visit.end, diagnoses,
    });
    const examination = [
        ...s.examinationFindings.map((f, i) => findingResource(`${key}:exam:${i}`, f, patient, at, "Examination finding", undefined, practitioner)),
        ...visitVitalsToMeasurements(s.vitals, at).map((m, i) => measurementObservation(`${key}:vital:${i}`, m, patient, "Observation", practitioner)),
    ];
    const allergies = s.allergies?.trim() ? [allergyResource(`${key}:allergies`, s.allergies.trim(), patient, practitioner)] : [];
    const history = s.medicalHistory?.trim()
        ? [conditionResource(`${key}:history`, { text: s.medicalHistory.trim() }, patient, "Medical history")]
        : [];
    const medications = s.medications.map((m) => medicationRequestResource(m, patient, practitioner, s.authoredOn ?? s.visit.start, diagnoses));
    const procedures = s.procedures.map((p, i) => procedureResource(`${key}:procedure:${i}`, p, patient, s.visit.start));
    const notes = s.notes.filter((n) => n.trim()).map((n, i) =>
        findingResource(`${key}:note:${i}`, { text: "Clinical note" }, patient, s.visit.start, "Clinical note", n.trim(), practitioner));
    const followUp = s.followUp ? [followUpAppointmentResource(`${key}:follow-up`, s.followUp, patient, practitioner)] : [];
    const documents = s.documents.map((d) => documentReferenceResource(d, patient));

    const sections = [
        complaints.length ? section("Chief complaints", complaints, OP.ChiefComplaints) : null,
        examination.length ? section("Physical examination", examination, OP.PhysicalExamination) : null,
        allergies.length ? section("Allergies", allergies, OP.Allergies) : null,
        history.length ? section("Medical history", history, OP.MedicalHistory) : null,
        medications.length ? section("Medications", medications, OP.Medications) : null,
        procedures.length ? section("Procedure", procedures, OP.Procedure) : null,
        followUp.length ? section("Follow up", followUp, OP.FollowUp) : null,
        notes.length ? section("Other observations", notes, OP.OtherObservations) : null,
        documents.length ? section("Document reference", documents, OP.DocumentReference) : null,
    ].filter((x): x is NonNullable<typeof x> => x !== null);

    return documentBundle({
        hiType: "OPConsultation",
        profile: "OPConsultRecord",
        type: { coding: { code: "371530004", display: "Clinical consultation report" }, text: "Consultation report" },
        title: "Consultation report",
        key,
        date: s.visit.start,
        patient, author: practitioner, custodian: organization, encounter,
        sections,
        summary: `Consultation of ${s.patient.name} with ${s.practitioner.name} at ${s.organization.name} on ${fhirDate(s.visit.start)}`,
    }, [...complaints, ...diagnoses, ...examination, ...allergies, ...history, ...medications, ...procedures, ...followUp, ...notes, ...documents], now);
};

/** Prescription: one prescription's medicines, with the PDF the clinic generated when there is one. */
export const buildPrescription = (s: PrescriptionSource, now: Date = new Date()): FhirBundle => {
    const p = s.prescription;
    const key = `prescription-${p.id}`;
    const { patient, practitioner, organization } = parties(s);
    if (p.medications.length === 0) throw new FhirSourceError(`Prescription ${p.id} has no medicines.`);

    const diagnoses = p.diagnoses.map((d, i) => conditionResource(`${key}:diagnosis:${i}`, d, patient, "Diagnosis"));
    const medications = p.medications.map((m) => medicationRequestResource(m, patient, practitioner, p.date, diagnoses));
    const signed = p.signedCopy ? [binaryResource(`${key}:pdf`, p.signedCopy.contentType, p.signedCopy.data)] : [];
    const record = { code: "440545006", display: "Prescription record" };

    return documentBundle({
        hiType: "Prescription",
        profile: "PrescriptionRecord",
        type: { coding: record, text: "Prescription record" },
        title: "Prescription record",
        key,
        date: p.date,
        patient, author: practitioner, custodian: organization,
        sections: [section("Prescription record", [...medications, ...signed], record)],
        summary: `Prescription for ${s.patient.name} by ${s.practitioner.name}, ${fhirDate(p.date)}: ${p.medications.map((m) => m.name).join(", ")}`,
    }, [...medications, ...signed, ...diagnoses], now);
};

/**
 * DiagnosticReport: one lab or imaging report the clinic holds as a file. The file goes in as a
 * DocumentReference, which the section allows on its own: NRCES's DiagnosticReportLab and
 * DiagnosticReportImaging profiles require result observations or media and an interpretation,
 * which a scanned report does not carry, so no DiagnosticReport resource is invented for it.
 */
export const buildDiagnosticReport = (s: DiagnosticReportSource, now: Date = new Date()): FhirBundle => {
    const key = `report-${s.report.id}`;
    const { patient, practitioner, organization } = parties(s);
    const studies = { code: "721981007", display: "Diagnostic studies report" };
    // 4241000179101 is the code NRCES's own examples type a laboratory report with.
    const file = documentReferenceResource(s.report, patient, s.kind === "lab" ? { code: "4241000179101", display: "Laboratory report" } : undefined);
    const title = s.kind === "lab" ? "Laboratory report" : "Imaging report";

    return documentBundle({
        hiType: "DiagnosticReport",
        profile: "DiagnosticReportRecord",
        type: { coding: studies, text: title },
        title: `${title}: ${s.report.title}`,
        key,
        date: s.report.createdAt,
        patient, author: practitioner, custodian: organization,
        sections: [section(title, [file], studies)],
        summary: `${title} for ${s.patient.name}: ${s.report.title}, ${fhirDate(s.report.createdAt)}`,
    }, [file], now);
};

/** HealthDocumentRecord: documents the clinic holds that are not a lab, imaging or prescription record. */
export const buildHealthDocumentRecord = (s: HealthDocumentSource, now: Date = new Date()): FhirBundle => {
    const { patient, practitioner, organization } = parties(s);
    if (s.documents.length === 0) throw new FhirSourceError(`No documents for ${s.key}.`);
    const artifact = { code: "419891008", display: "Record artifact" };
    const files = s.documents.map((d) => documentReferenceResource(d, patient));

    return documentBundle({
        hiType: "HealthDocumentRecord",
        profile: "HealthDocumentRecord",
        type: { coding: artifact, text: "Health document" },
        title: s.title,
        key: s.key,
        date: s.date,
        patient, author: practitioner, custodian: organization,
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
    const sections = order.filter((name) => bySection.has(name)).map((name) => section(WELLNESS_TITLES[name], bySection.get(name)!));

    return documentBundle({
        hiType: "WellnessRecord",
        profile: "WellnessRecord",
        type: { text: "Wellness Record" },
        title: "Wellness Record",
        key: s.key,
        date: s.date,
        patient, author: practitioner, custodian: organization,
        sections,
        summary: `Wellness record for ${s.patient.name}, ${fhirDate(s.date)}`,
    }, [...bySection.values()].flat(), now);
};

const BILLING = "https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-billing-codes";
const PRICE = "https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-price-components";
// ndhm-billing-codes (IG 6.5.0): 00 Consultation, 03 OPD, 99 Others
const billingCode = (itemType: string) =>
    itemType === "Consultation" ? { code: "00", display: "Consultation" }
        : itemType === "TreatmentPlan" ? { code: "03", display: "OPD" }
            : { code: "99", display: "Others" };
const money = (value: number) => ({ value: Math.round(value * 100) / 100, currency: "INR" });
const INVOICE_STATUS: Record<string, string> = { Pending: "issued", PartiallyPaid: "issued", Paid: "balanced" };

/** Invoice: an issued appointment bill. A draft bill is not an invoice yet and is not shared. */
export const buildInvoice = (s: InvoiceSource, now: Date = new Date()): FhirBundle => {
    const b = s.bill;
    const status = INVOICE_STATUS[b.status];
    if (!status) throw new FhirSourceError(`Bill ${b.number} is ${b.status}, not issued.`);
    if (b.items.length === 0) throw new FhirSourceError(`Bill ${b.number} has no items.`);
    const key = `bill-${b.id}`;
    const { patient, practitioner, organization } = parties(s);
    const splitGst = b.igst <= 0;

    const charges = b.items.map((item) => ({
        resourceType: "ChargeItem",
        id: resourceId("ChargeItem", item.id),
        meta: { profile: [NRCES + "ChargeItem"] },
        text: narrative(`${item.name} x ${item.quantity}`),
        status: "billed",
        code: { coding: [{ system: BILLING, ...billingCode(item.type) }] },
        subject: ref(patient, "Patient"),
        performer: [{ actor: ref(practitioner, "Practitioner") }],
        quantity: { value: item.quantity },
        productCodeableConcept: { text: item.name },
    } as FhirResource));

    const lineItem = b.items.map((item, i) => ({
        sequence: i + 1,
        chargeItemReference: ref(charges[i]!, "ChargeItem"),
        priceComponent: [
            { type: "base", code: { coding: [{ system: PRICE, code: "01", display: "Rate" }] }, amount: money(item.unitPrice * item.quantity) },
            ...(item.discount > 0 ? [{ type: "discount", code: { coding: [{ system: PRICE, code: "02", display: "Discount" }] }, amount: money(item.discount) }] : []),
            ...(item.gstAmount > 0
                ? splitGst
                    ? [
                        { type: "tax", code: { coding: [{ system: PRICE, code: "03", display: "CGST" }] }, amount: money(item.gstAmount / 2) },
                        { type: "tax", code: { coding: [{ system: PRICE, code: "04", display: "SGST" }] }, amount: money(item.gstAmount / 2) },
                    ]
                    // ndhm-price-components has no IGST code: named in text instead.
                    : [{ type: "tax", code: { text: "IGST" }, amount: money(item.gstAmount) }]
                : []),
        ],
    }));

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
        totalNet: money(b.subTotal - b.discount),
        totalGross: money(b.total),
    };

    return documentBundle({
        hiType: "Invoice",
        profile: "InvoiceRecord",
        type: { text: "Invoice Record" },
        title: `Invoice ${b.number}`,
        key,
        date: b.date,
        patient, author: practitioner, custodian: organization,
        sections: [section("Invoice", [invoice])],
        summary: `Invoice ${b.number} for ${s.patient.name} from ${s.organization.name}, INR ${b.total}`,
    }, [invoice, ...charges], now);
};

/** ImmunizationRecord: the vaccines given, the next dose due, and a certificate if one was uploaded. */
export const buildImmunizationRecord = (s: ImmunizationSource, now: Date = new Date()): FhirBundle => {
    if (s.immunizations.length === 0) throw new FhirSourceError(`No immunizations for ${s.key}.`);
    const { patient, practitioner, organization } = parties(s);
    const record = { code: "41000179103", display: "Immunization record" };

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
        ...(im.lotNumber ? { lotNumber: im.lotNumber } : {}),
        ...(im.site ? { site: { text: im.site } } : {}),
        ...(im.route ? { route: { text: im.route } } : {}),
        performer: [{ actor: ref(practitioner, "Practitioner") }],
        ...(im.manufacturer || im.notes ? { note: [{ text: [im.manufacturer ? `Manufacturer: ${im.manufacturer}` : null, im.notes].filter(Boolean).join(". ") }] } : {}),
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
        recommendation: due.map((im) => ({
            vaccineCode: [concept(im.vaccine)],
            forecastStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/immunization-recommendation-status", code: "due", display: "Due" }] },
            dateCriterion: [{
                code: { coding: [{ system: LOINC, code: "30980-7", display: "Date vaccine due" }] },
                value: fhirDate(im.nextDueDate!),
            }],
        })),
    }] : [];
    const certificate = s.certificate ? [documentReferenceResource(s.certificate, patient)] : [];

    return documentBundle({
        hiType: "ImmunizationRecord",
        profile: "ImmunizationRecord",
        type: { coding: record, text: "Immunization record" },
        title: "Immunization record",
        key: s.key,
        date: s.date,
        patient, author: practitioner, custodian: organization,
        sections: [section("Immunization record", [...immunizations, ...recommendation, ...certificate], record)],
        summary: `Immunization record for ${s.patient.name}: ${s.immunizations.map((im) => im.vaccine.text).join(", ")}`,
    }, [...immunizations, ...recommendation, ...certificate], now);
};

// DischargeSummaryRecord section slices, discriminated on code.coding.code
const DS = {
    ChiefComplaints: { code: "422843007", display: "Chief complaint section" },
    PhysicalExamination: { code: "425044008", display: "Physical exam section" },
    Allergies: { code: "722446000", display: "Allergy record" },
    MedicalHistory: { code: "1003642006", display: "Past medical history section" },
    Investigations: { code: "721981007", display: "Diagnostic studies report" },
    Medications: { code: "1003606003", display: "Medication history section" },
    Procedures: { code: "1003640003", display: "History of past procedure section" },
    CarePlan: { code: "734163000", display: "Care plan" },
    DocumentReference: { code: "373942005", display: "Discharge summary" },
};

/** DischargeSummary: one hospital stay, written up when the patient leaves. */
export const buildDischargeSummary = (s: DischargeSummarySource, now: Date = new Date()): FhirBundle => {
    const d = s.summary;
    const key = `discharge-${d.id}`;
    const { patient, practitioner, organization } = parties(s);

    const complaints = d.chiefComplaints.map((c, i) => conditionResource(`${key}:complaint:${i}`, c, patient, "Chief complaint"));
    const diagnoses = d.diagnoses.map((c, i) => conditionResource(`${key}:diagnosis:${i}`, c, patient, "Diagnosis"));
    const history = d.medicalHistory.map((c, i) => conditionResource(`${key}:history:${i}`, c, patient, "Medical history"));
    const encounter = encounterResource({
        key, kind: "inpatient", patient, start: d.admittedAt, end: d.dischargedAt, diagnoses, dischargeDisposition: d.disposition,
    });
    const examination = d.examinationFindings.map((f, i) => findingResource(`${key}:exam:${i}`, f, patient, d.admittedAt, "Examination finding", undefined, practitioner));
    const allergies = d.allergies?.trim() ? [allergyResource(`${key}:allergies`, d.allergies.trim(), patient, practitioner)] : [];
    const procedures = d.procedures.map((p, i) => procedureResource(`${key}:procedure:${i}`, p, patient, d.admittedAt));
    const medications = d.medications.map((m) => medicationRequestResource(m, patient, practitioner, d.dischargedAt, diagnoses));
    const planText = [d.carePlan?.trim(), d.followUp ? `Follow up on ${fhirDate(d.followUp)}.` : null].filter(Boolean).join(" ");
    const carePlan: FhirResource[] = planText ? [{
        resourceType: "CarePlan",
        id: resourceId("CarePlan", key),
        meta: { profile: [NRCES + "CarePlan"] },
        text: narrative(planText),
        status: "active",
        intent: "plan",
        title: "Discharge care plan",
        description: planText,
        subject: ref(patient, "Patient"),
        period: { start: fhirDateTime(d.dischargedAt), ...(d.followUp ? { end: fhirDateTime(d.followUp) } : {}) },
        author: ref(practitioner, "Practitioner"),
    }] : [];
    const document = s.document ? [documentReferenceResource(s.document, patient, DS.DocumentReference)] : [];

    const sections = [
        complaints.length ? section("Chief complaints", complaints, DS.ChiefComplaints) : null,
        examination.length ? section("Physical examination", examination, DS.PhysicalExamination) : null,
        allergies.length ? section("Allergies", allergies, DS.Allergies) : null,
        history.length ? section("Medical history", history, DS.MedicalHistory) : null,
        // Investigations are recorded as text; the slice's entries must be full lab or imaging reports.
        d.investigations?.trim() ? section("Investigations", [], DS.Investigations, d.investigations.trim()) : null,
        procedures.length ? section("Procedures", procedures, DS.Procedures) : null,
        medications.length ? section("Medications", medications, DS.Medications) : null,
        carePlan.length ? section("Care plan", carePlan, DS.CarePlan) : null,
        document.length ? section("Document reference", document, DS.DocumentReference) : null,
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
    }, [...complaints, ...diagnoses, ...history, ...examination, ...allergies, ...procedures, ...medications, ...carePlan, ...document], now);
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
