import { test } from "node:test";
import assert from "node:assert/strict";
import { planMedicationChanges, sortMedications } from "./prescription-medications.js";

const row = (Id: string, Medication: string, SortOrder: number | null, CreatedAt = "2026-11-10T10:00:00Z", Dosage = "") =>
    ({ Id, Medication, SortOrder, CreatedAt, Dosage });
const line = (medication: string, dosage = "") => ({ medication, dosage });

test("medicines come back in the order they were written, whatever order the database returns", () => {
    const fromDb = [row("c", "Cetirizine", 3), row("a", "Paracetamol", 1), row("b", "Azithromycin", 2)];
    assert.deepEqual(sortMedications(fromDb).map((m) => m.Medication), ["Paracetamol", "Azithromycin", "Cetirizine"]);
});

test("older medicines without a position keep their saved order, after numbered ones", () => {
    const fromDb = [row("x", "Old B", null, "2026-11-01T10:00:02Z"), row("y", "Old A", null, "2026-11-01T10:00:01Z"), row("z", "New", 1)];
    assert.deepEqual(sortMedications(fromDb).map((m) => m.Medication), ["New", "Old A", "Old B"]);
});

test("editing one medicine keeps it in its place instead of moving it to the end", () => {
    const existing = [row("a", "Paracetamol", 1, undefined, "650 mg"), row("b", "Azithromycin", 2, undefined, "500 mg"), row("c", "Cetirizine", 3, undefined, "10 mg")];
    // The doctor changed the second medicine's dosage.
    const plan = planMedicationChanges(existing, [line("Paracetamol", "650 mg"), line("Azithromycin", "250 mg"), line("Cetirizine", "10 mg")]);
    assert.deepEqual(plan.keep, [{ id: "a", sortOrder: 1 }, { id: "c", sortOrder: 3 }]);
    assert.equal(plan.insert.length, 1);
    assert.equal(plan.insert[0].sortOrder, 2);
    assert.deepEqual(plan.remove, ["b"]);
});

test("reordering, adding and removing medicines saves the new order", () => {
    const existing = [row("a", "A", 1), row("b", "B", 2), row("c", "C", 3)];
    const plan = planMedicationChanges(existing, [line("C"), line("D"), line("A")]);
    assert.deepEqual(plan.keep, [{ id: "c", sortOrder: 1 }, { id: "a", sortOrder: 3 }]);
    assert.deepEqual(plan.insert.map((i) => [i.medication.medication, i.sortOrder]), [["D", 2]]);
    assert.deepEqual(plan.remove, ["b"]);
});

test("a medicine sent twice is kept once, and old duplicate rows are removed", () => {
    const existing = [row("a1", "A", null, "2026-11-01T10:00:00Z"), row("a2", "A", null, "2026-11-01T10:00:05Z")];
    const plan = planMedicationChanges(existing, [line("A"), line("A")]);
    assert.deepEqual(plan.keep, [{ id: "a1", sortOrder: 1 }]);
    assert.equal(plan.insert.length, 0);
    assert.deepEqual(plan.remove, ["a2"]);
});
