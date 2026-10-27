import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReport, diagnosticReportColumns, interpretationOf, reportResults } from "./diagnostic-report.service.js";
import { bmiOf, checkWellness, toWellnessView, wellnessColumns } from "./wellness-record.service.js";
import { AbdmHealthRecordService } from "../Abdm/abdm-health-record.service.js";
import { fixtureParties } from "../Abdm/fhir/fhir-fixtures.js";

const now = new Date("2026-10-27T12:00:00+05:30");
const base = { patientId: "p", hospitalId: 20, category: "Lab" as const, testName: "Complete blood count", issuedAt: "2026-10-27T10:00:00+05:30" };

test("a result without a flag is flagged from its range; a bad result or range is refused with the line named", () => {
    assert.equal(interpretationOf({ value: 11.2, low: 13, high: 17 }), "low");
    assert.equal(interpretationOf({ value: 18, low: 13, high: 17 }), "high");
    assert.equal(interpretationOf({ value: 14, low: 13, high: 17 }), "normal");
    assert.equal(interpretationOf({ value: 14 }), null, "no range, no flag");
    const stored = JSON.parse(reportResults([{ name: "Haemoglobin", value: "11.2", unit: "g/dL", low: 13, high: 17 }, { name: "Smear", valueText: "Normocytic" }])!);
    assert.deepEqual(stored, [{ name: "Haemoglobin", value: 11.2, unit: "g/dL", low: 13, high: 17, interpretation: "low" }, { name: "Smear", valueText: "Normocytic" }]);
    assert.throws(() => reportResults([{ name: "Haemoglobin" }]), /results\[0\] \(Haemoglobin\) needs a value/);
    assert.throws(() => reportResults([{ name: "Hb", value: 1, low: 5, high: 2 }]), /low is above its high/);
    assert.throws(() => reportResults([{ name: "Hb", value: 1, interpretation: "weird" }]), /normal, high, low or abnormal/);
    assert.throws(() => diagnosticReportColumns({ ...base, category: "Xray" as any }), /Lab or Imaging/);
    assert.throws(() => diagnosticReportColumns({ ...base, testConceptId: "abc" }), /LOINC code or a SNOMED CT/);
    assert.equal(diagnosticReportColumns({ ...base, testConceptId: "58410-2" }).TestConceptId, "58410-2", "a LOINC code");
    assert.equal(diagnosticReportColumns({ ...base, testConceptId: "26604007" }).TestConceptId, "26604007", "a SNOMED CT concept");
});

test("a Final report holds what NRCES requires and is not issued in the future; a Draft may be incomplete", () => {
    const row = (input: any) => ({ Status: "Draft", ...diagnosticReportColumns({ ...base, ...input }) });
    assert.doesNotThrow(() => checkReport(row({}), now), "a draft");
    assert.throws(() => checkReport(row({ status: "Final", results: [{ name: "Hb", value: 11 }] }), now), /conclusion/);
    assert.throws(() => checkReport(row({ status: "Final", conclusion: "Mild anaemia." }), now), /lab report needs at least one result/);
    assert.doesNotThrow(() => checkReport(row({ status: "Final", conclusion: "Mild anaemia.", results: [{ name: "Hb", value: 11 }] }), now));
    assert.throws(() => checkReport(row({ status: "Final", category: "Imaging", conclusion: "Normal study." }), now), /image or scan report/);
    assert.doesNotThrow(() => checkReport(row({ status: "Final", category: "Imaging", conclusion: "Normal study.", documentId: 9 }), now));
    assert.throws(() => checkReport(row({ status: "Final", conclusion: "x", results: [{ name: "Hb", value: 1 }], issuedAt: "2026-10-28T10:00:00+05:30" }), now), /issued in the future/);
    assert.throws(() => checkReport(row({ collectedAt: "2026-10-27T11:00:00+05:30" }), now), /collectedAt can't be after issuedAt/);
});

test("a wellness record measures something in a believable range, BP as a pair, and works out BMI", () => {
    const w = { patientId: "p", hospitalId: 20, recordedAt: "2026-10-27T10:00:00+05:30" };
    assert.throws(() => checkWellness(wellnessColumns(w), now), /at least one measurement/);
    assert.throws(() => checkWellness(wellnessColumns({ ...w, systolic: 120 }), now), /both systolic and diastolic/);
    assert.throws(() => checkWellness(wellnessColumns({ ...w, systolic: 80, diastolic: 90 }), now), /below systolic/);
    assert.throws(() => wellnessColumns({ ...w, spo2: 140 }), /SpO2 \(%\) must be between 50 and 100/);
    assert.throws(() => wellnessColumns({ ...w, heartRate: 72.5 }), /whole number/);
    assert.throws(() => checkWellness(wellnessColumns({ ...w, heartRate: 72, recordedAt: "2026-10-28T10:00:00+05:30" }), now), /future/);
    const cols = wellnessColumns({ ...w, systolic: 120, diastolic: 80, heightCm: 170, weightKg: "65.04" as any, temperatureC: 36.84 });
    assert.doesNotThrow(() => checkWellness(cols, now));
    assert.equal(cols.WeightKg, 65, "to one decimal");
    assert.equal(cols.TemperatureC, 36.8);
    assert.equal(bmiOf(170, 65), 22.5);
    assert.equal(bmiOf(null, 65), null);
    assert.equal(toWellnessView({ ...cols, HeightCm: "170.0", WeightKg: "65.0" } as any).Bmi, 22.5, "decimals as the database returns them");
});

test("a Final report and a wellness record are built as their ABDM bundles; a Draft report is not shared", async () => {
    const report = {
        Id: 7, Status: "Final", Category: "Lab", TestName: "Complete blood count", TestConceptId: "26604007",
        IssuedAt: new Date("2026-10-27T10:00:00+05:30"), CollectedAt: new Date("2026-10-27T08:00:00+05:30"),
        SpecimenType: "Blood specimen", SpecimenConceptId: "119297000", PerformedBy: "In-house lab",
        Results: JSON.stringify([{ name: "Haemoglobin", value: 11.2, unit: "g/dL", low: 13, high: 17, interpretation: "low" }]),
        Conclusion: "Mild anaemia.", ConclusionCodes: JSON.stringify([{ text: "Anaemia", conceptId: "271737000" }]),
    };
    const wellness = { Id: 3, RecordedAt: new Date("2026-10-27T09:00:00+05:30"), Systolic: 120, Diastolic: 80, HeartRate: 72, SpO2: 98, HeightCm: "170.0", WeightKg: "65.0", Steps: 4200 };
    const service = (status: string) => new AbdmHealthRecordService({
        diagnosticReport: async () => ({ row: { ...report, Status: status }, parties: fixtureParties, document: null }),
        wellnessRecord: async () => ({ row: wellness, parties: fixtureParties }),
    } as any, () => now);

    assert.deepEqual(await service("Draft").forDiagnosticReport(7), []);
    const [dr] = await service("Final").forDiagnosticReport(7);
    const resources = dr!.bundle.entry.map((e: any) => e.resource);
    assert.equal(dr!.hiType, "DiagnosticReport");
    assert.ok(resources.some((r: any) => r.resourceType === "DiagnosticReport" && r.conclusion === "Mild anaemia."));
    assert.ok(resources.some((r: any) => r.resourceType === "Specimen"));

    const [wr] = await service("Final").forWellnessRecord(3);
    const codes = wr!.bundle.entry.map((e: any) => e.resource).filter((r: any) => r.resourceType === "Observation").map((o: any) => o.code.coding[0].code);
    assert.equal(wr!.hiType, "WellnessRecord");
    for (const loinc of ["85354-9", "8867-4", "2708-6", "8302-2", "29463-7", "39156-5", "55423-8"]) assert.ok(codes.includes(loinc), `has ${loinc}`);
});
