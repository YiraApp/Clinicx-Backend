import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { FhirBundle, HiType } from "../fhir/fhir-common.js";
import { BUILDERS } from "../fhir/health-records.js";
import { FIXTURES, fixtureParties } from "../fhir/fhir-fixtures.js";
import { recordPdfOf } from "../fhir/record-pdf.js";
import type { HealthRecordBundle } from "../abdm-health-record.service.js";
import type { StoredPdf } from "../../../repositories/Abdm/abdm-record-pdf.repository.js";
import { bundleIdOf } from "../record-pdf-preview.service.js";
import { RecordPdfArchive, targetOfSave, type ArchiveDeps } from "./record-pdf-archive.js";
import type { Hip } from "./m2-store.js";

/** Every version of each shared record's PDF, kept in the private container. Made-up records only. */

const HIP: Hip = { id: "IN3610000001", hospitalId: 12, name: "ClinicX Test Hospital" };
const PATIENT = fixtureParties.patient.id;
const NOW = new Date("2026-10-26T12:00:00+05:30");

const bundleOf = <T extends HiType>(hiType: T, source: unknown = FIXTURES[hiType]): HealthRecordBundle => {
    const bundle = (BUILDERS[hiType] as (s: unknown, now: Date) => FhirBundle)(source, NOW);
    return { hiType, key: bundle.id, bundle };
};

const memory = () => {
    const rows: StoredPdf[] = [];
    const uploads: Array<{ path: string; data: Buffer }> = [];
    const store = {
        async has(h: number, r: string, k: string, s: string) { return rows.some((x) => x.hospitalId === h && x.reference === r && x.recordKey === k && x.sha1 === s); },
        async add(row: Omit<StoredPdf, "id">) { rows.push({ ...row, id: String(rows.length + 1) }); },
        async list(h: number, r: string, k: string) { return rows.filter((x) => x.hospitalId === h && x.reference === r && x.recordKey === k).reverse(); },
        async get(h: number, r: string, k: string, id: string) { return rows.find((x) => x.id === id && x.hospitalId === h && x.reference === r && x.recordKey === k) ?? null; },
    };
    const blobs = {
        async upload(path: string, data: Buffer) { uploads.push({ path, data }); return `https://example.blob.core.windows.net/abdm-record-pdfs/${path}`; },
        async read(url: string) { return uploads.find((u) => url.endsWith(u.path))!.data; },
    };
    return { rows, uploads, store, blobs };
};

const archiveWith = (bundles: Record<string, HealthRecordBundle[]>, over: Partial<ArchiveDeps> = {}) => {
    const m = memory();
    const built: string[] = [];
    const archive = new RecordPdfArchive({
        owners: { owners: async () => [{ patientId: PATIENT, hospitalId: HIP.hospitalId }] },
        hips: async () => [HIP],
        store: m.store,
        blobs: m.blobs,
        bundles: async (reference) => { built.push(reference); return bundles[reference] ?? []; },
        prescriptionVisit: async () => null,
        references: async () => Object.keys(bundles),
        settleMs: 10_000,
        now: () => NOW,
        ...over,
    });
    return { archive, built, ...m };
};

test("a save points at the care context it changed: a visit's records the visit, others their own", () => {
    assert.deepEqual(targetOfSave({ patientId: PATIENT, hospitalId: 12, appointmentId: 101 }, { table: "PatientPrescription", id: "rx-1" }), { references: ["OP-101"] });
    assert.deepEqual(targetOfSave({ patientId: PATIENT, hospitalId: 12, appointmentId: null }, { table: "PatientPrescription", id: "rx-1" }), { references: ["RX-rx-1"] });
    assert.deepEqual(targetOfSave({ patientId: PATIENT, hospitalId: 12, appointmentId: 101 }, { table: "DiagnosticReports", id: "4" }), { references: ["DR-4"] }, "a report is its own care context, even made at a visit");
    assert.deepEqual(targetOfSave({ patientId: PATIENT, hospitalId: 12 }, { table: "WellnessRecords", id: "9" }), { references: ["WR-9"] });
    assert.deepEqual(targetOfSave({ patientId: PATIENT, hospitalId: 12 }, { table: "PatientMedicalRecord", id: "mr-1", vitals: true }), { references: ["VT-mr-1"] });
    assert.deepEqual(targetOfSave({ patientId: PATIENT, hospitalId: 12 }, { table: "PatientMedicalRecord", id: "mr-1", vitals: false }), { references: ["MR-mr-1"] });
    assert.deepEqual(targetOfSave({ patientId: PATIENT, hospitalId: 12 }, { table: "DiagnosticReports", id: null }), { kinds: ["report"] }, "an update that names no row: the patient's reports");
    assert.deepEqual(targetOfSave({ recentIn: "AppointmentBills", since: NOW }, { table: "AppointmentBills", id: null }), { kinds: ["visit"] });
    assert.deepEqual(targetOfSave({ patientId: PATIENT, hospitalId: 12 }, { table: "MedicalDocuments", id: "3" }), { references: [] }, "an upload is its own record: no PDF is built of it");
});

test("each record's PDF is stored once, at a path with no patient detail; a changed record adds a version", async () => {
    const op = bundleOf("OPConsultation");
    const docs = bundleOf("HealthDocumentRecord");
    const { archive, rows, uploads } = archiveWith({ "OP-101": [op, docs] });

    assert.equal(await archive.store({ hip: HIP, patientId: PATIENT, reference: "OP-101" }), 1, "the health document carries no PDF of its own");
    const pdf = recordPdfOf(op.bundle)!.data;
    const sha1 = createHash("sha1").update(pdf).digest("hex");
    assert.equal(uploads[0]!.path, `12/OP-101/OPConsultation/${op.key}/${sha1}.pdf`);
    assert.ok(!uploads[0]!.path.includes(fixtureParties.patient.name) && !uploads[0]!.path.includes(PATIENT), "no name or patient id in the path");
    assert.deepEqual(uploads[0]!.data, pdf);
    assert.deepEqual({ ...rows[0], id: undefined, blobUrl: undefined }, {
        id: undefined, hospitalId: 12, patientUserId: PATIENT, reference: "OP-101", hiType: "OPConsultation", recordKey: op.key,
        source: "generated", sha1, bytes: pdf.length, blobUrl: undefined, createdAt: NOW,
    });

    assert.equal(await archive.store({ hip: HIP, patientId: PATIENT, reference: "OP-101" }), 0, "an unchanged record isn't stored again");

    const changed = bundleOf("OPConsultation", { ...FIXTURES.OPConsultation, notes: ["Review in a week."] });
    const again = archiveWith({ "OP-101": [changed] }, { store: (archive as any).deps.store, blobs: (archive as any).deps.blobs });
    assert.equal(await again.archive.store({ hip: HIP, patientId: PATIENT, reference: "OP-101" }), 1);
    const versions = await archive.versions(12, { reference: "OP-101", hiType: "OPConsultation", recordKey: "appointment-101" });
    assert.equal(versions.length, 2, "both versions of the record, newest first");
    assert.equal(bundleIdOf({ hiType: "OPConsultation", recordKey: "appointment-101" }), op.key, "versions are found by the record's bundle id");
    assert.deepEqual(await archive.version(12, { reference: "OP-101", hiType: "OPConsultation", recordKey: "appointment-101" }, versions[1]!.id), pdf);
    assert.equal(await archive.version(99, { reference: "OP-101", hiType: "OPConsultation", recordKey: "appointment-101" }, versions[1]!.id), null, "another hospital's ask finds nothing");
});

test("saves settle, then only the care contexts they changed are built; a prescription line finds its visit", async () => {
    const { archive, built, rows } = archiveWith(
        { "OP-101": [bundleOf("Prescription")], "WR-9": [bundleOf("WellnessRecord")], "IM-3": [bundleOf("ImmunizationRecord")] },
        { prescriptionVisit: async (id) => (id === "rx-1" ? 101 : null) },
    );
    archive.recordSaved({ prescriptionId: "rx-1" }, { table: "PatientPrescription", id: "rx-1" });
    archive.recordSaved({ patientId: PATIENT, hospitalId: 12 }, { table: "WellnessRecords", id: "9" });
    archive.recordSaved({ patientId: PATIENT, hospitalId: 12 }, { table: "WellnessRecords", id: "9" });
    await archive.settle();
    assert.deepEqual(built.sort(), ["OP-101", "WR-9"], "the immunization's care context is not rebuilt");
    assert.equal(rows.length, 2);
});

test("only ABDM facilities store PDFs, and a failure is logged without breaking anything", async () => {
    const none = archiveWith({ "WR-9": [bundleOf("WellnessRecord")] }, { hips: async () => [] });
    none.archive.recordSaved({ patientId: PATIENT, hospitalId: 12 }, { table: "WellnessRecords", id: "9" });
    await none.archive.settle();
    assert.deepEqual(none.built, []);

    const failing = archiveWith({ "WR-9": [bundleOf("WellnessRecord")] }, { blobs: { upload: async () => { throw new Error("storage unavailable"); }, read: async () => Buffer.alloc(0) } });
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => { warned.push(m); };
    try {
        failing.archive.recordSaved({ patientId: PATIENT, hospitalId: 12 }, { table: "WellnessRecords", id: "9" });
        await failing.archive.settle();
    } finally {
        console.warn = warn;
    }
    assert.equal(failing.rows.length, 0);
    assert.equal(warned.length, 1);
    assert.match(warned[0]!, /WR-9 could not be stored: storage unavailable/);
    assert.ok(!warned[0]!.includes(fixtureParties.patient.name));
});
