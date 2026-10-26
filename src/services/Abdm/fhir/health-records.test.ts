import { test } from "node:test";
import assert from "node:assert/strict";
import { HI_TYPES, NRCES, FhirSourceError, type FhirBundle, type FhirResource, type HiType } from "./fhir-common.js";
import { BUILDERS, buildInvoice, buildOpConsultation, buildPrescription } from "./health-records.js";
import { FIXTURES, fixtureParties } from "./fhir-fixtures.js";

const NOW = new Date("2026-10-26T12:00:00+05:30");
const build = <T extends HiType>(hiType: T, source = FIXTURES[hiType]) => (BUILDERS[hiType] as (s: unknown, now: Date) => FhirBundle)(source, NOW);
const composition = (b: FhirBundle) => b.entry[0]!.resource as any;
const resources = (b: FhirBundle, type: string) => b.entry.map((e) => e.resource).filter((r) => r.resourceType === type) as any[];

/** Every "reference" anywhere in the bundle. */
const references = (value: unknown, out: string[] = []): string[] => {
    if (Array.isArray(value)) value.forEach((v) => references(v, out));
    else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
            if (k === "reference" && typeof v === "string") out.push(v);
            else references(v, out);
        }
    }
    return out;
};

// NRCES IG 6.5.0: the profile and the fixed Composition.type for each HI type
const EXPECTED: Record<HiType, { profile: string; code?: string; text?: string }> = {
    OPConsultation: { profile: "OPConsultRecord", code: "371530004" },
    Prescription: { profile: "PrescriptionRecord", code: "440545006" },
    DiagnosticReport: { profile: "DiagnosticReportRecord", code: "721981007" },
    DischargeSummary: { profile: "DischargeSummaryRecord", code: "373942005" },
    ImmunizationRecord: { profile: "ImmunizationRecord", code: "41000179103" },
    HealthDocumentRecord: { profile: "HealthDocumentRecord", code: "419891008" },
    WellnessRecord: { profile: "WellnessRecord", text: "Wellness Record" },
    Invoice: { profile: "InvoiceRecord", text: "Invoice Record" },
};

for (const hiType of HI_TYPES) {
    test(`${hiType}: an NRCES document bundle whose every reference resolves`, () => {
        const bundle = build(hiType);
        const c = composition(bundle);

        assert.equal(bundle.type, "document");
        assert.deepEqual((bundle.meta as any).profile, [NRCES + "DocumentBundle"]);
        assert.equal((bundle.meta as any).versionId, "1");
        assert.equal((bundle.meta as any).security[0].code, "V");
        assert.ok((bundle.identifier as any).system && (bundle.identifier as any).value);
        assert.ok(bundle.timestamp);

        assert.equal(c.resourceType, "Composition", "the Composition is the first entry");
        assert.deepEqual(c.meta.profile, [NRCES + EXPECTED[hiType].profile]);
        if (EXPECTED[hiType].code) {
            assert.equal(c.type.coding[0].system, "http://snomed.info/sct");
            assert.equal(c.type.coding[0].code, EXPECTED[hiType].code);
        } else {
            assert.equal(c.type.text, EXPECTED[hiType].text);
            assert.equal(c.type.coding, undefined);
        }
        assert.equal(c.status, "final");
        assert.ok(c.title && c.date && c.subject.reference && c.author[0].reference);
        assert.ok(c.section.length > 0);
        assert.equal(c.attester, undefined, "no attester without a party");
        assert.equal(c.relatesTo, undefined, "no relatesTo without a target");

        const ids = new Set(bundle.entry.map((e) => e.fullUrl));
        assert.equal(ids.size, bundle.entry.length, "each resource once");
        for (const e of bundle.entry) assert.equal(e.fullUrl, `urn:uuid:${e.resource.id}`);
        for (const r of references(bundle)) assert.ok(ids.has(r), `${r} resolves`);
        for (const s of c.section) {
            for (const entry of s.entry ?? []) {
                const target = bundle.entry.find((e) => e.fullUrl === entry.reference)!.resource;
                assert.equal(entry.type, target.resourceType, "section entries name their type");
            }
        }
    });
}

test("the same record builds the same resource ids", () => {
    for (const hiType of HI_TYPES) {
        assert.deepEqual(build(hiType).entry.map((e) => e.fullUrl), build(hiType).entry.map((e) => e.fullUrl), hiType);
    }
});

test("the patient carries the ABHA number both ways NRCES allows, the address, and the clinic's own id", () => {
    const patient = resources(build("Prescription"), "Patient")[0];
    const byCode = (code: string) => patient.identifier.filter((i: any) => i.type.coding[0].code === code);
    assert.equal(byCode("HIN")[0].value, "91-0000-0000-0000");
    assert.equal(byCode("ABHA")[0].value, "asha.test@sbx");
    const mr = byCode("MR");
    assert.ok(mr.some((i: any) => i.system === "https://healthid.ndhm.gov.in" && i.value === "91-0000-0000-0000"));
    assert.ok(mr.some((i: any) => i.value === fixtureParties.patient.id));
    assert.equal(patient.gender, "female");
    assert.equal(resources(build("Prescription"), "Organization")[0].identifier[0].value, "IN3610001937");
});

test("narratives escape the patient's name", () => {
    const div = composition(build("OPConsultation")).text.div as string;
    assert.ok(div.includes("Asha &lt;Test&gt; &amp; Rao"));
    assert.ok(!div.includes("<Test>"));
});

test("OPConsultation: sections carry the codes OPConsultRecord fixes, vitals are coded and typed text is not", () => {
    const bundle = build("OPConsultation");
    const codes = Object.fromEntries(composition(bundle).section.map((s: any) => [s.title, s.code.coding[0].code]));
    assert.deepEqual(codes, {
        "Chief complaints": "422843007",
        "Physical examination": "425044008",
        "Allergies": "722446000",
        "Medical history": "371529009",
        "Medications": "721912009",
        "Procedure": "371525003",
        "Follow up": "390906007",
        "Other observations": "404684003",
        "Document reference": "371530004",
    });
    assert.ok(composition(bundle).encounter, "OPConsultRecord requires the encounter");

    const observations = resources(bundle, "Observation");
    const bp = observations.find((o) => o.code.coding?.[0].code === "85354-9");
    assert.deepEqual(bp.component.map((c: any) => [c.code.coding[0].code, c.valueQuantity.value]), [["8480-6", 120], ["8462-4", 80]]);
    const temperature = observations.find((o) => o.code.coding?.[0].code === "61008-9");
    assert.deepEqual([temperature.valueQuantity.value, temperature.valueQuantity.code], [98.4, "[degF]"]);

    const medication = resources(bundle, "MedicationRequest")[0];
    assert.equal(medication.medicationCodeableConcept.coding, undefined, "no concept was picked, so none is invented");
    assert.equal(medication.dosageInstruction[0].text, "650 mg, Twice daily, for 3 days");
    assert.equal(medication.dosageInstruction[0].route.text, "Oral");

    const complaint = resources(bundle, "Condition").find((c) => c.code.text === "Toothache");
    assert.deepEqual(complaint.code.coding, [{ system: "http://snomed.info/sct", code: "27355003", display: "Toothache" }]);
});

test("OPConsultation: vitals that can't be read are left out, and a visit with nothing recorded is refused", () => {
    const sparse = {
        ...FIXTURES.OPConsultation,
        chiefComplaints: [], examinationFindings: [], diagnoses: [], procedures: [], medications: [], notes: [], documents: [],
        allergies: null, medicalHistory: null, followUp: null,
        vitals: { bloodPressure: "high", heartRate: "-", temperature: null, weight: "", height: "" },
    };
    assert.throws(() => buildOpConsultation(sparse, NOW), FhirSourceError);
});

test("Prescription: one section of MedicationRequests and the PDF, coded as PrescriptionRecord fixes", () => {
    const bundle = build("Prescription");
    const s = composition(bundle).section;
    assert.equal(s.length, 1);
    assert.equal(s[0].code.coding[0].code, "440545006");
    assert.deepEqual(s[0].entry.map((e: any) => e.type), ["MedicationRequest", "MedicationRequest", "Binary"]);
    assert.equal(resources(bundle, "Binary")[0].contentType, "application/pdf");
    assert.throws(() => buildPrescription({ ...FIXTURES.Prescription, prescription: { ...FIXTURES.Prescription.prescription, medications: [] } }, NOW), FhirSourceError);
});

test("DiagnosticReport: the report file alone, typed as a laboratory report", () => {
    const s = composition(build("DiagnosticReport")).section[0];
    assert.deepEqual(s.entry.map((e: any) => e.type), ["DocumentReference"]);
    const doc = resources(build("DiagnosticReport"), "DocumentReference")[0];
    assert.equal(doc.type.coding[0].code, "4241000179101");
    assert.ok(doc.content[0].attachment.data.length > 0);
});

test("DischargeSummary: an inpatient stay, investigations as text, sections coded as DischargeSummaryRecord fixes", () => {
    const bundle = build("DischargeSummary");
    const c = composition(bundle);
    const encounter = resources(bundle, "Encounter")[0];
    assert.equal(encounter.class.code, "IMP");
    assert.ok(encounter.period.start && encounter.period.end);
    const byTitle = Object.fromEntries(c.section.map((s: any) => [s.title, s]));
    assert.equal(byTitle.Investigations.code.coding[0].code, "721981007");
    assert.equal(byTitle.Investigations.entry, undefined, "text only: no empty entry array");
    assert.ok(byTitle.Investigations.text.div.includes("Orthopantomogram"));
    assert.equal(byTitle["Medical history"].code.coding[0].code, "1003642006");
    assert.equal(byTitle.Medications.code.coding[0].code, "1003606003");
    assert.equal(byTitle["Care plan"].code.coding[0].code, "734163000");
});

test("ImmunizationRecord: the vaccine given and the dose due next", () => {
    const bundle = build("ImmunizationRecord");
    const immunization = resources(bundle, "Immunization")[0];
    assert.equal(immunization.occurrenceDateTime, "2026-10-20");
    assert.equal(immunization.protocolApplied[0].doseNumberPositiveInt, 1);
    const next = resources(bundle, "ImmunizationRecommendation")[0];
    assert.equal(next.recommendation[0].dateCriterion[0].value, "2026-11-20");
    assert.deepEqual(composition(bundle).section[0].entry.map((e: any) => e.type), ["Immunization", "ImmunizationRecommendation", "DocumentReference"]);
});

test("WellnessRecord: sections by the titles NRCES slices on, observations by its wellness profiles", () => {
    const bundle = build("WellnessRecord");
    const sections = composition(bundle).section;
    assert.deepEqual(sections.map((s: any) => s.title), ["Vital Signs", "Body Measurement", "Physical Activity", "General Assessment"]);
    const profiles = new Set(resources(bundle, "Observation").map((o) => o.meta.profile[0].split("/").pop()));
    assert.deepEqual([...profiles].sort(), ["ObservationBodyMeasurement", "ObservationGeneralAssessment", "ObservationPhysicalActivity", "ObservationVitalSigns"]);
});

test("Invoice: GST split into CGST and SGST, IGST named in text, and a draft bill is not an invoice", () => {
    const bundle = build("Invoice");
    const invoice = resources(bundle, "Invoice")[0];
    assert.equal(invoice.status, "balanced");
    assert.deepEqual(invoice.totalGross, { value: 1652, currency: "INR" });
    assert.deepEqual(invoice.totalNet, { value: 1400, currency: "INR" });
    const taxes = invoice.lineItem[1].priceComponent.filter((p: any) => p.type === "tax");
    assert.deepEqual(taxes.map((t: any) => [t.code.coding[0].display, t.amount.value]), [["CGST", 126], ["SGST", 126]]);
    assert.equal(resources(bundle, "ChargeItem")[0].code.coding[0].code, "00");

    const igst = buildInvoice({ ...FIXTURES.Invoice, bill: { ...FIXTURES.Invoice.bill, cgst: 0, sgst: 0, igst: 252 } }, NOW);
    const igstTax = (resources(igst, "Invoice")[0].lineItem[1].priceComponent as any[]).find((p) => p.type === "tax");
    assert.deepEqual([igstTax.code.text, igstTax.amount.value], ["IGST", 252]);

    assert.throws(() => buildInvoice({ ...FIXTURES.Invoice, bill: { ...FIXTURES.Invoice.bill, status: "Draft" } }, NOW), FhirSourceError);
});

test("attachments never leave the bundle as anything but base64 of the file", () => {
    const doc = resources(build("HealthDocumentRecord"), "DocumentReference")[0] as FhirResource & any;
    assert.equal(Buffer.from(doc.content[0].attachment.data, "base64").toString(), "%PDF-1.4\n% fixture\n");
});
