import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AutoLinker, type RecordRef } from "./auto-link.js";
import { LinkingError } from "./hip-linking.js";
import { recordRefOf } from "./record-subscriber.js";
import type { Hip } from "./m2-store.js";

const OCIMUM: Hip = { id: "IN3610001937", hospitalId: 20, name: "Ocimum dentistry" };
const PATIENT = "5bfd87da-0ec5-4577-9740-77cf53c24425";

let linked: Array<[string, string]>;
let notified: Array<[string, string]>;
let autoLinkHips: Hip[];
let noAbha: Set<string>;

/** Owners as the database would answer: prescription rx-1 and appointment 7 are the patient's at hospital 20. */
const owners = {
    async owner(ref: RecordRef) {
        if (ref.prescriptionId) return ref.prescriptionId === "rx-1" ? { patientId: PATIENT, hospitalId: 20 } : null;
        if (ref.appointmentId) return ref.appointmentId === 7 ? { patientId: PATIENT, hospitalId: 20 } : null;
        return ref.patientId && ref.hospitalId ? { patientId: ref.patientId.toLowerCase(), hospitalId: ref.hospitalId } : null;
    },
};
const linking = {
    async link(hip: Hip, userId: string) {
        if (noAbha.has(userId)) throw new LinkingError("The patient has no ABHA address yet: verify or create their ABHA first.");
        linked.push([hip.id, userId]);
        return { queued: 1, status: "awaiting-token" };
    },
    async notifyChanges(hip: Hip, userId: string) {
        notified.push([hip.id, userId]);
        return 0;
    },
};
const autoLinker = () => new AutoLinker(owners, { hips: async (o?: { autoLink?: boolean }) => (o?.autoLink ? autoLinkHips : [OCIMUM]) }, linking, 60_000);

beforeEach(() => {
    linked = [];
    notified = [];
    autoLinkHips = [OCIMUM];
    noAbha = new Set();
});

test("a burst of saves for one visit links the patient once, after it settles", async () => {
    const linker = autoLinker();
    linker.recordSaved({ patientId: PATIENT.toUpperCase(), hospitalId: 20, appointmentId: 7 });
    linker.recordSaved({ prescriptionId: "rx-1" });
    linker.recordSaved({ patientId: PATIENT, hospitalId: 20 });
    assert.equal(linked.length, 0, "nothing before the burst settles");

    await linker.settle();
    assert.deepEqual(linked, [[OCIMUM.id, PATIENT]]);
    assert.deepEqual(notified, [[OCIMUM.id, PATIENT]], "records added to care contexts already linked are announced too");
});

test("a hospital without AutoLink, or a record at another hospital, links nothing", async () => {
    autoLinkHips = [];
    const linker = autoLinker();
    linker.recordSaved({ patientId: PATIENT, hospitalId: 20 });
    await linker.settle();

    autoLinkHips = [OCIMUM];
    linker.recordSaved({ patientId: PATIENT, hospitalId: 19 });
    await linker.settle();
    assert.deepEqual(linked, []);
});

test("a patient with no ABHA is skipped quietly, and the rest still link", async () => {
    noAbha.add("no-abha");
    const linker = autoLinker();
    linker.recordSaved({ patientId: "no-abha", hospitalId: 20 });
    linker.recordSaved({ patientId: PATIENT, hospitalId: 20 });
    await linker.settle();
    assert.deepEqual(linked, [[OCIMUM.id, PATIENT]]);
});

test("each record table is read for its owner; other tables are ignored", () => {
    assert.deepEqual(recordRefOf("DischargeSummaries", { Id: 4, PatientId: PATIENT, HospitalId: 20, Status: "Final" }), { patientId: PATIENT, hospitalId: 20, appointmentId: null });
    assert.deepEqual(recordRefOf("PatientMedicalRecord", { PatientId: PATIENT, AppointmentId: 7 }), { patientId: PATIENT, hospitalId: null, appointmentId: 7 });
    assert.deepEqual(recordRefOf("PrescriptionMedication", { Id: "m-1", PrescriptionId: "rx-1" }), { prescriptionId: "rx-1" });
    assert.equal(recordRefOf("PatientPrescription", { PatientId: PATIENT }), null, "no hospital and no visit: nowhere to share it from");
    assert.equal(recordRefOf("Users", { Id: PATIENT }), null);
    assert.equal(recordRefOf("Appointments", { UserId: PATIENT, HospitalId: 20 }), null);
});
