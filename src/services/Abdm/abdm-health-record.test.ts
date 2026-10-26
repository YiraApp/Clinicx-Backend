import { test } from "node:test";
import assert from "node:assert/strict";
import { AbdmHealthRecordService, diagnosticKind, isVitalsRecord, visitSources } from "./abdm-health-record.service.js";
import type { VisitRecords } from "../../repositories/Abdm/abdm-health-record.repository.js";
import { documentContentType, visitStart } from "../../repositories/Abdm/abdm-health-record.repository.js";
import { fixtureParties } from "./fhir/fhir-fixtures.js";
import { immunizationColumns } from "../Appointments/immunization.service.js";
import { codedList, dischargeSummaryColumns } from "../Appointments/discharge-summary.service.js";

const pdf = Buffer.from("%PDF-1.4\n");
const day = new Date("2026-10-20T10:00:00+05:30");

const visit = (overrides: Partial<VisitRecords> = {}): VisitRecords => ({
    parties: fixtureParties,
    appointment: { id: 101, start: day, end: null, teleconsultation: false },
    registration: { allergies: "Penicillin", medicalHistory: null },
    medicalRecords: [
        { Id: "mr-1", Type: "Consultation", Date: day, ChiefComplaint: "Toothache", ChiefComplaintConceptId: "27355003", Diagnosis: "Dental caries", DiagnosisConceptId: "80967001", BloodPressure: "120/80", HeartRate: "72" } as any,
        { Id: "mr-2", Type: "Vitals Check", Date: day, BloodPressure: "118/76", Weight: "62", SpO2: "98" } as any,
    ],
    prescriptions: [{
        row: { Id: "rx-1", Date: day, PrescriptionNumber: 1, CreatedAt: day } as any,
        medications: [{ id: "m-1", name: "Paracetamol 650 mg tablet", dosage: "650 mg" }],
        diagnoses: [],
        pdf,
    }],
    notes: ["Advised warm saline rinses."],
    documents: [
        { id: "d-1", title: "CBC", category: "Lab", contentType: "application/pdf", data: pdf, createdAt: day },
        { id: "d-2", title: "OPG", category: "Imaging / Radiology", contentType: "image/jpeg", data: pdf, createdAt: day },
        { id: "d-3", title: "Insurance card", category: "Insurance", contentType: "application/pdf", data: pdf, createdAt: day },
    ],
    bills: [{
        AppointmentBillId: "bill-1", BillNumber: "INV-1", CreatedAt: day, BillStatus: "Pending",
        SubTotal: 500, DiscountAmount: 0, TotalAmount: 500, CgstAmount: 0, SgstAmount: 0, IgstAmount: 0,
        BillItems: [{ AppointmentBillItemId: "i-1", ItemType: "Consultation", ItemName: "Consultation fee", Quantity: 1, UnitPrice: 500, DiscountAmount: 0, GstAmount: 0, TotalAmount: 500 }],
    } as any],
    immunizations: [{ Id: 7, VaccineName: "Tetanus toxoid vaccine", AdministeredOn: "2026-10-20", DoseNumber: 1 } as any],
    certificates: new Map(),
    ...overrides,
});

test("a visit with something of each kind offers seven HI types, each from the right records", () => {
    const sources = visitSources(visit());
    assert.deepEqual(sources.map((s) => s.hiType), [
        "OPConsultation", "Prescription", "DiagnosticReport", "DiagnosticReport", "HealthDocumentRecord", "WellnessRecord", "Invoice", "ImmunizationRecord",
    ]);
    const op = sources.find((s) => s.hiType === "OPConsultation")!.source as any;
    assert.deepEqual(op.chiefComplaints, [{ text: "Toothache", conceptId: "27355003" }]);
    assert.equal(op.vitals.bloodPressure, "120/80", "the consultation's own vitals, not the vitals check's");
    assert.deepEqual(op.notes, ["Advised warm saline rinses."]);
    const wellness = sources.find((s) => s.hiType === "WellnessRecord")!.source as any;
    assert.deepEqual(wellness.measurements.map((m: any) => m.kind), ["bloodPressure", "oxygenSaturation", "weight"]);
    const reports = sources.filter((s) => s.hiType === "DiagnosticReport").map((s) => (s.source as any).kind);
    assert.deepEqual(reports, ["lab", "imaging"]);
    const docs = sources.find((s) => s.hiType === "HealthDocumentRecord")!.source as any;
    assert.deepEqual(docs.documents.map((d: any) => d.title), ["Insurance card"]);
});

test("a visit with nothing recorded offers nothing, and allergies alone are not a consultation", () => {
    assert.deepEqual(visitSources(visit({ medicalRecords: [], prescriptions: [], notes: [], documents: [], bills: [], immunizations: [] })), []);
});

test("lab and imaging categories are diagnostic reports, others are health documents", () => {
    assert.equal(diagnosticKind("Lab Report"), "lab");
    assert.equal(diagnosticKind("Pathology"), "lab");
    assert.equal(diagnosticKind("Imaging / Radiology"), "imaging");
    assert.equal(diagnosticKind("X-Ray"), "imaging");
    assert.equal(diagnosticKind("Clinical"), null);
    assert.equal(diagnosticKind("Health Camp Report"), null);
    assert.equal(isVitalsRecord({ Type: "Patient Self-Reported Vitals" } as any), true);
    assert.equal(isVitalsRecord({ Type: "Consultation" } as any), false);
});

test("uploads stored as octet-stream are typed by their extension, and a visit starts at its slot", () => {
    assert.equal(documentContentType("application/octet-stream", "pdf"), "application/pdf");
    assert.equal(documentContentType("application/octet-stream", ".JPG"), "image/jpeg");
    assert.equal(documentContentType("image/png", "png"), "image/png");
    const start = visitStart(new Date(2026, 9, 20), "14:30:00");
    assert.deepEqual([start.getHours(), start.getMinutes()], [14, 30]);
});

const service = (records: any) => new AbdmHealthRecordService(records, () => new Date("2026-10-26T12:00:00+05:30"));

test("the service builds a bundle for each record, and can be asked for some HI types only", async () => {
    const records = { visit: async () => visit() };
    const all = await service(records).forAppointment(101);
    assert.equal(all.length, 8);
    for (const r of all) assert.equal(r.bundle.type, "document");
    const some = await service(records).forAppointment(101, ["Prescription", "Invoice"]);
    assert.deepEqual(some.map((r) => r.hiType), ["Prescription", "Invoice"]);
});

test("a draft discharge summary is not shared; a final one is", async () => {
    const summary = (Status: string) => ({
        summary: { Id: 3, Status, AdmittedAt: day, DischargedAt: new Date("2026-10-22T10:00:00+05:30"), ChiefComplaints: JSON.stringify([{ text: "Swelling" }]), Diagnoses: null },
        parties: fixtureParties, medications: [], document: null,
    });
    assert.deepEqual(await service({ dischargeSummary: async () => summary("Draft") }).forDischargeSummary(3), []);
    const final = await service({ dischargeSummary: async () => summary("Final") }).forDischargeSummary(3);
    assert.deepEqual(final.map((r) => r.hiType), ["DischargeSummary"]);
});

test("an immunization given outside a visit is a record of its own", async () => {
    const records = { immunization: async () => ({ row: { Id: 9, VaccineName: "Hepatitis B vaccine", AdministeredOn: "2026-10-01", CertificateDocumentId: null }, parties: fixtureParties, certificates: new Map() }) };
    const built = await service(records).forImmunization(9);
    assert.deepEqual(built.map((r) => r.hiType), ["ImmunizationRecord"]);
});

test("immunization input is checked before it is stored", () => {
    const valid = { patientId: "p", hospitalId: 12, vaccineName: "Tetanus toxoid vaccine", administeredOn: "2026-10-20" };
    assert.equal(immunizationColumns(valid).VaccineName, "Tetanus toxoid vaccine");
    assert.throws(() => immunizationColumns({ ...valid, vaccineName: " " }), /vaccineName/);
    assert.throws(() => immunizationColumns({ ...valid, administeredOn: "20/10/2026" }), /YYYY-MM-DD/);
    assert.throws(() => immunizationColumns({ ...valid, vaccineConceptId: "abc" }), /SNOMED/);
    assert.throws(() => immunizationColumns({ ...valid, nextDueDate: "2026-10-01" }), /before/);
    assert.deepEqual(immunizationColumns({ doseNumber: 2 }, true), { DoseNumber: 2 }, "an update sets only what it names");
});

test("discharge summary lists are { text, conceptId } and Final or Draft only", () => {
    assert.equal(codedList([{ text: " Fever ", conceptId: "386661006" }, "Cough"], "x"), JSON.stringify([{ text: "Fever", conceptId: "386661006" }, { text: "Cough" }]));
    assert.throws(() => codedList([{ text: "" }], "diagnoses"), /diagnoses\[0\]/);
    assert.throws(() => codedList([{ text: "Fever", conceptId: "fever" }], "diagnoses"), /SNOMED/);
    const base = { patientId: "p", doctorId: "d", hospitalId: 12, admittedAt: "2026-10-10T09:00:00+05:30", dischargedAt: "2026-10-12T09:00:00+05:30" };
    assert.equal(dischargeSummaryColumns(base).Status, "Draft");
    assert.throws(() => dischargeSummaryColumns({ ...base, status: "Done" as any }), /Draft or Final/);
});
