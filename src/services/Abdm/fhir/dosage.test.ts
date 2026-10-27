import { test } from "node:test";
import assert from "node:assert/strict";
import { doseOf, dosageOf, durationOf, instructionOf, instructionsOf, methodOf, routeOf, timingOf } from "./dosage.js";

test("the clinic's frequencies are read as FHIR timing; anything else is left to the text", () => {
    assert.deepEqual(timingOf("1-0-1 (Morning & Night)"), { timing: { repeat: { frequency: 2, period: 1, periodUnit: "d", when: ["MORN", "NIGHT"] } } });
    assert.deepEqual(timingOf("0-1-0 (Afternoon)"), { timing: { repeat: { frequency: 1, period: 1, periodUnit: "d", when: ["AFT"] } } });
    assert.deepEqual(timingOf("1-1-1"), { timing: { repeat: { frequency: 3, period: 1, periodUnit: "d", when: ["MORN", "AFT", "NIGHT"] } } });
    assert.deepEqual(timingOf("Once daily"), { timing: { repeat: { frequency: 1, period: 1, periodUnit: "d" } } });
    assert.deepEqual(timingOf("Every 8 hours"), { timing: { repeat: { frequency: 1, period: 8, periodUnit: "h" } } });
    assert.deepEqual(timingOf("SOS"), { asNeeded: true });
    assert.equal(timingOf("0-0-0"), null);
    assert.equal(timingOf("whenever it hurts a lot"), null);
    assert.equal(timingOf(null), null);
});

test("durations, doses, routes and food instructions are read where the words are clear", () => {
    assert.deepEqual(durationOf("7 days"), { value: 7, unit: "days", system: "http://unitsofmeasure.org", code: "d" });
    assert.deepEqual(durationOf("2 weeks"), { value: 2, unit: "weeks", system: "http://unitsofmeasure.org", code: "wk" });
    assert.equal(durationOf("Days"), null, "a unit with no number is not a duration");
    assert.deepEqual(doseOf("650 mg"), { value: 650, unit: "mg", system: "http://unitsofmeasure.org", code: "mg" });
    assert.deepEqual(doseOf("500mg"), { value: 500, unit: "mg", system: "http://unitsofmeasure.org", code: "mg" });
    assert.equal(doseOf("10"), null, "no unit, no quantity");
    assert.deepEqual(routeOf("Oral")?.coding?.[0]?.code, "26643006");
    assert.deepEqual(routeOf("Intravenous (IV)")?.coding?.[0]?.code, "47625008");
    assert.deepEqual(routeOf("Injection"), { text: "Injection" }, "Injection names no route");
    assert.equal(instructionOf("take after food")?.coding?.[0]?.code, "311504000");
    assert.deepEqual(instructionOf("drink water regularly"), { text: "drink water regularly" });
});

test("a prescription line becomes a FHIR Dosage with its sentence and every element it can read", () => {
    const d = dosageOf({ id: "m-1", name: "Paracetamol 650 mg tablet", dosage: "650 mg", frequency: "1-0-1 (Morning & Night)", duration: "5 days", route: "Oral", instructions: "After food" });
    assert.equal(d.text, "650 mg, 1-0-1 (Morning & Night), for 5 days");
    assert.deepEqual((d as any).timing.repeat, { frequency: 2, period: 1, periodUnit: "d", when: ["MORN", "NIGHT"], boundsDuration: { value: 5, unit: "days", system: "http://unitsofmeasure.org", code: "d" } });
    assert.equal((d as any).doseAndRate[0].doseQuantity.value, 650);
    assert.equal((d as any).route.coding[0].display, "Oral route");
    assert.equal((d as any).additionalInstruction[0].coding[0].code, "311504000");
    assert.deepEqual(dosageOf({ id: "m-2", name: "X" }), { text: "Dosage not recorded" });
});

test("meal and bedtime frequencies are FHIR event timings", () => {
    assert.deepEqual(timingOf("At bedtime"), { timing: { repeat: { frequency: 1, period: 1, periodUnit: "d", when: ["HS"] } } });
    assert.deepEqual(timingOf("Before meals"), { timing: { repeat: { when: ["AC"] } } });
    assert.deepEqual(timingOf("After meals"), { timing: { repeat: { when: ["PC"] } } });
    assert.deepEqual(timingOf("Once weekly"), { timing: { repeat: { frequency: 1, period: 1, periodUnit: "wk" } } });
    assert.deepEqual(timingOf("Alternate days"), { timing: { repeat: { frequency: 1, period: 2, periodUnit: "d" } } });
});

test("the method comes from the route, or the form where the name says it, and is left out otherwise", () => {
    assert.equal(methodOf("Oral", "Paracetamol 650 mg tablet")?.coding[0]?.code, "421521009", "swallow");
    assert.equal(methodOf("Oral", "Calcium carbonate 500 mg chewable tablet")?.coding[0]?.display, "Chew");
    assert.equal(methodOf("Injection", "Ceftriaxone 1 g")?.coding[0]?.display, "Inject");
    assert.equal(methodOf("Intramuscular (IM)", null)?.coding[0]?.display, "Inject");
    assert.equal(methodOf("Eye Drops", null)?.coding[0]?.display, "Instill");
    assert.equal(methodOf("Topical", null)?.coding[0]?.display, "Apply");
    assert.equal(methodOf("Sublingual", null), null, "no single method for it");
    assert.equal(methodOf("", "Dolo 650"), null);
});

test("several instructions are coded one by one, and unknown advice stays as words", () => {
    const parts = instructionsOf("After food; Avoid alcohol; Keep in the fridge");
    assert.deepEqual(parts.map((p) => p.coding?.[0]?.code ?? p.text), ["311504000", "419822006", "Keep in the fridge"]);
    assert.equal(instructionOf("Empty stomach")?.coding?.[0]?.code, "717154004");
    assert.equal(instructionOf("May cause drowsiness")?.coding?.[0]?.code, "418639000");
    const d = dosageOf({ id: "m-3", name: "Amoxicillin 500 mg capsule", route: "Oral", instructions: "After food. Complete the course" }) as any;
    assert.equal(d.method.coding[0].display, "Swallow");
    assert.deepEqual(d.additionalInstruction.map((i: any) => i.coding[0].code), ["311504000", "418577003"]);
    assert.equal(d.patientInstruction, "After food. Complete the course");
});
