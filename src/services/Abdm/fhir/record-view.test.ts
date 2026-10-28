import { test } from "node:test";
import assert from "node:assert/strict";
import type { FhirBundle, HiType } from "./fhir-common.js";
import { BUILDERS } from "./health-records.js";
import { FIXTURES } from "./fhir-fixtures.js";
import { recordView } from "./record-view.js";

const NOW = new Date("2026-10-26T12:00:00+05:30");
const view = <T extends HiType>(hiType: T) =>
    recordView({ hiType, bundle: (BUILDERS[hiType] as (s: unknown, now: Date) => FhirBundle)(FIXTURES[hiType], NOW) });
const section = (v: ReturnType<typeof view>, title: string) => v.sections.find((s) => s.title === title)?.items ?? [];

test("a consultation reads as its sections, with the doctor's name and the files it carries", () => {
    const v = view("OPConsultation");
    assert.equal(v.title, "Consultation report");
    assert.equal(v.author, "Dr. Kiran Test");
    assert.deepEqual(section(v, "Chief complaints"), ["Toothache"]);
    assert.ok(section(v, "Physical examination").includes("Blood pressure: 120/80 mmHg"), "blood pressure reads as a pair");
    assert.equal(section(v, "Medications")[0], "Paracetamol 650 mg tablet — 650 mg, Twice daily, for 3 days (for Dental caries)", "with the diagnosis it treats");
    assert.deepEqual(section(v, "Follow up"), ["Follow-up visit · 27 Oct 2026"]);
    assert.deepEqual(v.attachments.map((a) => [a.title, a.contentType]), [["Intraoral photo", "application/pdf"]]);
    assert.ok(v.attachments[0]!.bytes! > 0);
    assert.ok(v.sections.every((s) => s.items.every((i) => !/\bNA\b|undefined|null/.test(i))), "nothing missing is spelled out");
});

test("a prescription lists each medicine and its signed copy", () => {
    const v = view("Prescription");
    const items = section(v, "Prescription record");
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => i.includes(" — ")), "each medicine with its dosage");
    assert.deepEqual(v.attachments.map((a) => [a.title, a.contentType]), [["Prescription record (signed copy)", "application/pdf"]], "the signed copy is listed as a file");
});

test("a lab report shows its results with ranges and flags, its specimen and its conclusion", () => {
    const items = section(view("DiagnosticReport"), "Laboratory report");
    assert.equal(items[0], "Complete blood count · Laboratory · 19 Oct 2026");
    assert.ok(items.some((i) => i.startsWith("Specimen: Blood specimen")));
    assert.ok(items.some((i) => /^Haemoglobin: [\d.]+ g\/dL \(.*range/.test(i)), items.join("\n"));
    assert.equal(items.at(-1), "Conclusion: Mild anaemia.");
});

test("an invoice lists each charge with discount and tax, then the total and whether it is paid", () => {
    const items = section(view("Invoice"), "Invoice");
    assert.equal(items[0], "Consultation fee: ₹500");
    assert.match(items[1]!, /: ₹1,000, less ₹100, tax ₹252$/);
    assert.equal(items.at(-1), "Total ₹1,652 · before tax ₹1,400 · Paid");
});

test("an immunization shows the dose given and the next one due", () => {
    const items = section(view("ImmunizationRecord"), "Immunization record");
    assert.equal(items[0], "Tetanus toxoid vaccine · dose 1 · 20 Oct 2026 · manufacturer Test Biologicals · lot TT-2026-001");
    assert.equal(items[1], "Next dose of Tetanus toxoid vaccine · due 20 Nov 2026");
});

test("every HI type reads back with a title, a date and at least one section", () => {
    for (const hiType of Object.keys(BUILDERS) as HiType[]) {
        const v = view(hiType);
        assert.ok(v.title && v.date, hiType);
        assert.ok(v.sections.length > 0 && v.sections.every((s) => s.items.length > 0), `${hiType} has sections with lines`);
    }
});
