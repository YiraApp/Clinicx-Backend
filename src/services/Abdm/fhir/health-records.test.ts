import { test } from "node:test";
import assert from "node:assert/strict";
import { HI_TYPES, NRCES, FhirSourceError, type FhirBundle, type FhirResource, type HiType } from "./fhir-common.js";
import { BUILDERS, buildDischargeSummary, buildHealthDocumentRecord, buildImmunizationRecord, buildInvoice, buildOpConsultation, buildPrescription, buildWellnessRecord } from "./health-records.js";
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
        "Diagnosis": "29548-5",
    });
    assert.equal(composition(bundle).section.at(-1).title, "Diagnosis", "after every slice: the profile's sections are open at the end");
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
    const fileOnly = { ...FIXTURES.DiagnosticReport, entered: null };
    const s = composition(build("DiagnosticReport", fileOnly)).section[0];
    assert.deepEqual(s.entry.map((e: any) => e.type), ["DocumentReference"]);
    const doc = resources(build("DiagnosticReport", fileOnly), "DocumentReference")[0];
    assert.equal(doc.type.coding[0].code, "4241000179101");
    assert.ok(doc.content[0].attachment.data.length > 0);
});

test("DiagnosticReport: an entered lab report is a DiagnosticReportLab with its results, ranges, flags, specimen and file", () => {
    const bundle = build("DiagnosticReport");
    assert.deepEqual(composition(bundle).section[0].entry.map((e: any) => e.type), ["DiagnosticReport"]);
    const report = resources(bundle, "DiagnosticReport")[0];
    assert.equal(report.meta.profile[0], NRCES + "DiagnosticReportLab");
    assert.deepEqual(report.category, [{ text: "Laboratory" }]);
    assert.deepEqual(report.code.coding[0], { system: "http://loinc.org", code: "58410-2", display: "Complete blood count" });
    assert.equal(report.conclusion, "Mild anaemia.");
    assert.equal(report.conclusionCode[0].coding[0].code, "271737000");
    assert.equal(report.result.length, 3);
    assert.ok(report.resultsInterpreter.length && report.presentedForm[0].data.length > 0);
    const [hb, tlc, smear] = resources(bundle, "Observation");
    assert.deepEqual(hb.valueQuantity, { value: 11.2, unit: "g/dL" });
    assert.deepEqual(hb.referenceRange, [{ low: { value: 13, unit: "g/dL" }, high: { value: 17, unit: "g/dL" } }]);
    assert.equal(hb.interpretation[0].coding[0].code, "L");
    assert.equal(tlc.interpretation[0].coding[0].code, "N");
    assert.equal(smear.valueString, "Microcytic hypochromic picture");
    const specimen = resources(bundle, "Specimen")[0];
    assert.ok(specimen.receivedTime && specimen.collection.collectedDateTime);
    assert.equal(hb.specimen.reference, `urn:uuid:${specimen.id}`);
});

test("DiagnosticReport: an imaging report carries its image as Media; one without a conclusion, results or image is refused", () => {
    const imaging = { ...FIXTURES.DiagnosticReport, kind: "imaging" as const, entered: { ...FIXTURES.DiagnosticReport.entered!, results: [], specimen: null } };
    const bundle = build("DiagnosticReport", imaging);
    const report = resources(bundle, "DiagnosticReport")[0];
    assert.equal(report.meta.profile[0], NRCES + "DiagnosticReportImaging");
    assert.equal(report.media[0].link.reference, `urn:uuid:${resources(bundle, "Media")[0].id}`);
    assert.ok(report.presentedForm[0].data, "the file as issued, which is what a PHR app lists and opens");
    assert.equal(resources(bundle, "Media")[0].subject.reference, `urn:uuid:${resources(bundle, "Patient")[0].id}`);

    const entered = FIXTURES.DiagnosticReport.entered!;
    assert.throws(() => build("DiagnosticReport", { ...FIXTURES.DiagnosticReport, entered: { ...entered, conclusion: " " } }), FhirSourceError);
    assert.throws(() => build("DiagnosticReport", { ...FIXTURES.DiagnosticReport, entered: { ...entered, results: [] } }), FhirSourceError);
    assert.throws(() => build("DiagnosticReport", { ...imaging, document: null }), FhirSourceError);
});

test("DischargeSummary: an inpatient stay, investigations and diagnoses listed, sections coded as DischargeSummaryRecord fixes", () => {
    const bundle = build("DischargeSummary");
    const c = composition(bundle);
    const encounter = resources(bundle, "Encounter")[0];
    assert.equal(encounter.class.code, "IMP");
    assert.ok(encounter.period.start && encounter.period.end);
    const byTitle = Object.fromEntries(c.section.map((s: any) => [s.title, s]));
    // Investigations typed as text are an observation a PHR app prints; the diagnoses a section of their own, both after the slices
    assert.deepEqual(c.section.slice(-2).map((s: any) => [s.title, s.code.coding[0].system, s.code.coding[0].code]),
        [["Investigations", "http://loinc.org", "30954-2"], ["Discharge diagnosis", "http://loinc.org", "11535-2"]]);
    const investigations = resources(bundle, "Observation").find((o) => o.code.text === "Investigations");
    assert.ok(investigations.valueString.includes("Orthopantomogram") && investigations.effectivePeriod.start);
    assert.deepEqual(byTitle["Discharge diagnosis"].entry.map((e: any) => e.type), ["Condition"]);
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

test("Invoice: GST split into CGST and SGST, IGST coded in Clinicx's system, and a draft bill is not an invoice", () => {
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
    assert.deepEqual(igstTax.code.coding, [{ system: "https://clinicx.yira.ai/fhir/price-components", code: "IGST", display: "IGST" }]);
    assert.deepEqual([igstTax.code.text, igstTax.amount.value], ["IGST", 252]);
    // NRCES Invoice: every price component's code has exactly one coding with system, code and display
    for (const b of [bundle, igst]) {
        for (const p of resources(b, "Invoice")[0].lineItem.flatMap((l: any) => l.priceComponent)) {
            assert.equal(p.code.coding?.length, 1, `${p.type} has one coding`);
            assert.ok(p.code.coding[0].system && p.code.coding[0].code && p.code.coding[0].display, `${p.type} coding is complete`);
        }
    }

    assert.throws(() => buildInvoice({ ...FIXTURES.Invoice, bill: { ...FIXTURES.Invoice.bill, status: "Draft" } }, NOW), FhirSourceError);
});

test("attachments never leave the bundle as anything but base64 of the file", () => {
    const doc = resources(build("HealthDocumentRecord"), "DocumentReference")[0] as FhirResource & any;
    assert.equal(Buffer.from(doc.content[0].attachment.data, "base64").toString(), "%PDF-1.4\n% fixture\n");
});

test("every record names its encounter, so a PHR app shows the visit type instead of NA", () => {
    for (const hiType of HI_TYPES) {
        const bundle = build(hiType);
        const ref = composition(bundle).encounter?.reference;
        assert.ok(ref, `${hiType} has Composition.encounter`);
        const encounter = bundle.entry.find((e) => e.fullUrl === ref)?.resource as any;
        assert.equal(encounter?.resourceType, "Encounter", `${hiType}'s encounter is in the bundle`);
        assert.ok(["AMB", "VR", "IMP"].includes(encounter.class.code), hiType);
    }
    // Records of one visit share its encounter
    const visitOf = { ...fixtureParties, visit: { id: 101, start: new Date("2026-10-20T10:00:00+05:30"), end: null, teleconsultation: false } };
    const invoice = build("Invoice", { ...FIXTURES.Invoice, ...visitOf });
    const prescription = build("Prescription", { ...FIXTURES.Prescription, ...visitOf });
    assert.equal(composition(invoice).encounter.reference, composition(prescription).encounter.reference);
});

test("conditions say when they were recorded, and medicines name the diagnosis they treat in words", () => {
    for (const hiType of ["OPConsultation", "Prescription", "DischargeSummary"] as const) {
        const conditions = resources(build(hiType), "Condition");
        assert.ok(conditions.length && conditions.every((c) => c.recordedDate), `${hiType} conditions have recordedDate`);
    }
    const meds = resources(build("Prescription"), "MedicationRequest");
    assert.ok(meds.every((m) => m.reasonCode?.length === m.reasonReference?.length && m.reasonCode[0].text), "reasonCode beside reasonReference");
});

test("an adult's blood pressure carries the reference range and interpretation; a child's does not", () => {
    const bp = (birthDate: string) => resources(build("WellnessRecord", { ...FIXTURES.WellnessRecord, patient: { ...fixtureParties.patient, birthDate } }), "Observation")
        .find((o) => o.component)!.component;
    const adult = bp("1990-04-12");
    assert.deepEqual(adult.map((c: any) => c.interpretation[0].coding[0].code), ["N", "N"], "118/76 is normal");
    assert.deepEqual([adult[0].referenceRange[0].low.value, adult[0].referenceRange[0].high.value], [90, 139]);
    const child = bp("2020-01-01");
    assert.ok(child.every((c: any) => !c.interpretation && !c.referenceRange));
    const temperature = resources(build("OPConsultation"), "Observation").find((o) => o.code?.coding?.[0]?.code === "61008-9");
    assert.ok(["°C", "°F"].includes(temperature.valueQuantity.unit), "a readable unit, the UCUM code beside it");
});

test("an immunization's route and site are coded where the form's choice names one", () => {
    const im = resources(build("ImmunizationRecord", { ...FIXTURES.ImmunizationRecord, immunizations: FIXTURES.ImmunizationRecord.immunizations.map((i) => ({ ...i, route: "Intradermal", site: "Left deltoid" })) }), "Immunization")[0];
    assert.equal(im.route.coding[0].code, "372464004");
    assert.deepEqual([im.site.coding[0].code, im.site.text], ["LD", "Left deltoid"]);
});

test("'no' is nothing recorded: no allergies coded as such, no history or finding called 'no'", () => {
    const op = buildOpConsultation({ ...FIXTURES.OPConsultation, allergies: "No", medicalHistory: "nil", examinationFindings: [{ text: "no" }] }, NOW);
    const allergy = resources(op, "AllergyIntolerance")[0];
    assert.deepEqual([allergy.code.coding[0].code, allergy.code.text], ["716186003", "No known allergies"]);
    assert.ok(allergy.text.div.includes("Allergies: No"), "the clinic's own word stays in the narrative");
    const titles = composition(op).section.map((x: any) => x.title);
    assert.ok(!titles.includes("Medical history"));
    assert.ok(!resources(op, "Observation").some((o) => o.code.text === "no"));
    const penicillin = resources(buildOpConsultation({ ...FIXTURES.OPConsultation, allergies: "no penicillin" }, NOW), "AllergyIntolerance")[0];
    assert.deepEqual(penicillin.code, { text: "no penicillin" }, "only the whole value is a negation");
    const ds = buildDischargeSummary({ ...FIXTURES.DischargeSummary, summary: { ...FIXTURES.DischargeSummary.summary, examinationFindings: [{ text: "no" }] } }, NOW);
    assert.ok(!composition(ds).section.some((x: any) => x.title === "Physical examination"));
});

test("Invoice: the lines carry the bill as charged and add up to its total", () => {
    const lines = (b: any) => resources(b, "Invoice")[0].lineItem.map((l: any) => l.priceComponent.map((p: any) => [p.code.coding[0].display, p.amount.value]));
    const sum = (b: any) => Math.round(resources(b, "Invoice")[0].lineItem.flatMap((l: any) => l.priceComponent)
        .reduce((t: number, p: any) => t + (p.type === "discount" ? -1 : 1) * p.amount.value, 0) * 100) / 100;
    // GST rounded to whole rupees on the bill, and stored as a three-way C/S/I split: CGST and SGST that add up
    const items = [
        { id: "a", type: "Consultation", name: "Consultation", quantity: 1, unitPrice: 750, discount: 0, gstAmount: 37.5, total: 787.5 },
        { id: "b", type: "TreatmentPlan", name: "Scaling", quantity: 1, unitPrice: 1200, discount: 0, gstAmount: 60, total: 1260 },
        { id: "c", type: "TreatmentPlan", name: "Polishing", quantity: 1, unitPrice: 500, discount: 0, gstAmount: 25, total: 525 },
    ];
    const rounded = buildInvoice({ ...FIXTURES.Invoice, bill: { ...FIXTURES.Invoice.bill, subTotal: 2450, discount: 0, total: 2573, gst: 123, cgst: 41, sgst: 41, igst: 41, items } }, NOW);
    assert.ok(lines(rounded).flat().every(([head]: any) => head !== "IGST"), "a three-way split is not IGST");
    assert.equal(sum(rounded), 2573, "the lines add up to Total Gross");
    assert.deepEqual(resources(rounded, "Invoice")[0].totalNet, { value: 2450, currency: "INR" });
    // IGST only when the bill charged IGST alone
    const igst = buildInvoice({ ...FIXTURES.Invoice, bill: { ...FIXTURES.Invoice.bill, cgst: 0, sgst: 0, igst: 252, gst: 252 } }, NOW);
    assert.deepEqual(lines(igst)[1].filter(([h]: any) => /GST/.test(h)), [["IGST", 252]]);
    // A concession on the whole bill shows on the lines, shared by price
    const concession = buildInvoice({ ...FIXTURES.Invoice, bill: { ...FIXTURES.Invoice.bill, discount: 400, total: 1352, gst: 252 } }, NOW);
    assert.equal(sum(concession), 1352);
    assert.deepEqual(resources(concession, "Invoice")[0].totalPriceComponent[0].amount, { value: 300, currency: "INR" });
    assert.throws(() => buildInvoice({ ...FIXTURES.Invoice, bill: { ...FIXTURES.Invoice.bill, number: "DFT-123456-7890" } }, NOW), FhirSourceError);
});

test("DischargeSummary: the follow-up is the care plan's appointment, and medicines treat the prescription's diagnoses when the summary names none", () => {
    const bundle = build("DischargeSummary");
    const plan = resources(bundle, "CarePlan")[0];
    assert.equal(plan.period.end, undefined, "no end before the start when the follow-up is on the discharge day");
    const appointment = bundle.entry.find((e) => e.fullUrl === plan.activity[0].outcomeReference[0].reference)!.resource as any;
    assert.equal(appointment.resourceType, "Appointment");
    assert.ok(appointment.start && appointment.end, "a PHR app prints its start and end, not NA");
    const noDiagnoses = buildDischargeSummary({ ...FIXTURES.DischargeSummary, summary: { ...FIXTURES.DischargeSummary.summary, diagnoses: [], prescriptionDiagnoses: [{ text: "Dental abscess" }] } }, NOW);
    assert.deepEqual(resources(noDiagnoses, "MedicationRequest")[0].reasonCode.map((c: any) => c.text), ["Dental abscess"]);
    assert.ok(!composition(noDiagnoses).section.some((x: any) => x.title === "Discharge diagnosis"), "the prescription's diagnoses are not the stay's");
});

test("ImmunizationRecord: the manufacturer where a PHR app prints it, and who gave it only when recorded", () => {
    const [im] = resources(build("ImmunizationRecord"), "Immunization");
    assert.deepEqual(im.manufacturer, { display: "Test Biologicals" });
    assert.equal(im.performer, undefined, "not recorded, so not claimed");
    const given = buildImmunizationRecord({ ...FIXTURES.ImmunizationRecord, immunizations: FIXTURES.ImmunizationRecord.immunizations.map((i) => ({ ...i, performer: { id: "doc-2", name: "Dr. Given" } })) }, NOW);
    const [withGiver] = resources(given, "Immunization");
    assert.equal(withGiver.performer[0].function.coding[0].code, "AP");
    assert.equal(resources(given, "Practitioner").length, 2, "the giver beside the record's author");
    assert.equal(resources(given, "ImmunizationRecommendation")[0].recommendation[0].supportingImmunization[0].reference, `urn:uuid:${withGiver.id}`);
});

test("WellnessRecord: the clinic's note, and measurements named as the clinic names them", () => {
    const bundle = buildWellnessRecord({ ...FIXTURES.WellnessRecord, notes: "Walks daily." }, NOW);
    const sections = composition(bundle).section;
    assert.equal(sections.at(-1).title, "Other Observations");
    assert.ok(resources(bundle, "Observation").some((o) => o.valueString === "Walks daily."));
    const spo2 = resources(bundle, "Observation").find((o) => o.code.coding?.[0].code === "2708-6");
    assert.deepEqual([spo2.code.text, spo2.code.coding[0].display], ["Oxygen saturation (SpO2)", "Oxygen saturation in Arterial blood"]);
});

test("HealthDocumentRecord: the same file saved twice is listed once", () => {
    const doc = FIXTURES.HealthDocumentRecord.documents[0]!;
    const bundle = buildHealthDocumentRecord({ ...FIXTURES.HealthDocumentRecord, documents: [doc, { ...doc, id: "copy", title: "Sent on WhatsApp" }] }, NOW);
    assert.deepEqual(resources(bundle, "DocumentReference").map((d) => d.content[0].attachment.title), ["Old discharge card"]);
});

test("OPConsultation: each prescription's medicines by its prescriber, and its notes once", () => {
    const op = buildOpConsultation({
        ...FIXTURES.OPConsultation,
        prescriptions: [{
            date: new Date("2026-10-20T10:30:00+05:30"), diagnoses: [{ text: "Dental caries", conceptId: "80967001" }],
            medications: [{ id: "m-9", name: "Ibuprofen 400 mg tablet", dosage: "400 mg", prescriptionNotes: "Review in a week" }],
            practitioner: { id: "doc-2", name: "Dr. Other" }, notes: "Review in a week",
        }],
    }, NOW);
    const med = resources(op, "MedicationRequest")[0];
    const prescriber = resources(op, "Practitioner").find((p) => p.name[0].text === "Dr. Other");
    assert.equal(med.requester.reference, `urn:uuid:${prescriber.id}`);
    assert.equal(med.authoredOn, "2026-10-20T10:30:00+05:30");
    assert.deepEqual(med.note, [{ text: "Review in a week" }]);
    assert.ok(resources(op, "Observation").some((o) => o.code.text === "Prescription notes" && o.valueString === "Review in a week"));
});

test("Prescription: its notes print once, after the last medicine's dosage, unless the desk wrote them into the advice", () => {
    const rx = (notes: string, instructions?: string) => buildPrescription({ ...FIXTURES.Prescription, prescription: { ...FIXTURES.Prescription.prescription,
        notes, medications: FIXTURES.Prescription.prescription.medications.map((m) => ({ ...m, instructions, prescriptionNotes: notes })) } }, NOW);
    const texts = (b: any) => resources(b, "MedicationRequest").map((m) => m.dosageInstruction[0].text);
    const shown = texts(rx("Drink water"));
    assert.ok(shown[1].endsWith(". Notes: Drink water") && !shown[0].includes("Drink water"));
    assert.ok(!texts(rx("Drink water", "After food. Drink water")).some((t: string) => t.includes("Notes:")));
    assert.ok(!texts(rx("Drink water.", "drink  water")).some((t: string) => t.includes("Notes:")), "the same words, whatever their case");
    for (const none of ["no", "Nil"]) assert.ok(!texts(rx(none)).some((t: string) => t.includes("Notes:")), `"${none}" is no notes`);
    // Whole words only: "Ice" is not said by "Twice daily", "Rest" not by "interest"
    assert.ok(texts(rx("Ice", "Twice daily after food")).at(-1).endsWith("Notes: Ice"));
    assert.deepEqual(resources(rx("Ice", "Twice daily after food"), "MedicationRequest")[0].note, [{ text: "Ice" }]);
    assert.ok(!texts(rx("Drink water. ", "Drink water")).some((t: string) => t.includes("Notes:")), "a full stop and a space after it are punctuation");
    const dated = texts(rx("Review on 10.05.2026")).at(-1) as string;
    assert.ok(!dated.includes(".0") && dated.replace(/\u2060/g, "").endsWith("Notes: Review on 10.05.2026"), "the app's '.0' removal can't touch the date");
});
