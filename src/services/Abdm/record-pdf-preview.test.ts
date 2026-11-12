import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { RecordPdfError, RecordPdfService, bundleIdOf, isRecordPdfType } from "./record-pdf-preview.service.js";
import { AbdmHealthRecordRepository, type VisitRecords } from "../../repositories/Abdm/abdm-health-record.repository.js";
import { fixtureParties } from "./fhir/fhir-fixtures.js";
import { wellnessColumns } from "../Appointments/wellness-record.service.js";
import { diagnosticReportColumns } from "../Appointments/diagnostic-report.service.js";
import { immunizationColumns } from "../Appointments/immunization.service.js";

// The made-up fixture patient and clinic only (fhir-fixtures.ts)
const PATIENT = fixtureParties.patient.id;
const HOSPITAL = Number(fixtureParties.organization.id);
const DOCTOR = fixtureParties.practitioner.id;
const day = new Date("2026-10-20T10:00:00+05:30");
const NOW = new Date("2026-10-21T11:00:00+05:30");
const CLINIC_PDF = Buffer.from("%PDF-1.4\n% the clinic's own prescription PDF\n%%EOF\n");

const pdfText = (pdf: Buffer): string => {
    const out: string[] = [];
    for (const m of pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
        let content: string;
        try {
            content = inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1");
        } catch {
            continue;
        }
        for (const tj of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
            out.push([...tj[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1]!, "hex").toString("latin1")).join(""));
        }
    }
    return out.join("\n");
};

const visit = (overrides: Partial<VisitRecords> = {}): VisitRecords => ({
    parties: fixtureParties,
    appointment: { id: 101, start: day, end: null, teleconsultation: false },
    registration: { allergies: null, medicalHistory: null },
    medicalRecords: [],
    prescriptions: [],
    notes: [],
    documents: [],
    bills: [],
    immunizations: [],
    certificates: new Map(),
    ...overrides,
});

const notFound = (what: string) => async () => { throw new Error(`${what} not found.`); };
const real = new AbdmHealthRecordRepository();

/** A repository that only reads, from memory: nothing a preview does can write. */
const repo = (over: Record<string, unknown> = {}): any => ({
    parties: async (_patientId: string, _doctorId: string | null, hospitalId: number) => {
        assert.equal(hospitalId, HOSPITAL, "the request's hospital, whatever the form says");
        return fixtureParties;
    },
    visit: async () => visit(),
    providerAt: async () => null,
    visitRef: async () => null,
    document: async () => null,
    certificates: async () => new Map(),
    medication: (m: any, notes?: string | null) => real.medication(m, notes),
    bill: notFound("Bill"),
    prescriptionParts: async () => ({ medications: [], diagnoses: [] }),
    immunization: notFound("Immunization"),
    wellnessRecord: notFound("Wellness record"),
    diagnosticReport: notFound("Diagnostic report"),
    dischargeSummary: notFound("Discharge summary"),
    prescription: notFound("Prescription"),
    consultationRecord: notFound("Medical record"),
    clinicalNote: notFound("Clinical note"),
    vitalsRecord: notFound("Vitals record"),
    standaloneDocument: notFound("Document"),
    ...over,
});

const service = (over: Record<string, unknown> = {}, rendered: any[] = []) =>
    new RecordPdfService(repo(over), () => NOW, async (p) => {
        rendered.push(p);
        return CLINIC_PDF;
    });

const ctx = { patientId: PATIENT, hospitalId: HOSPITAL };
const rejects = (p: Promise<unknown>, status: number, message: RegExp) =>
    assert.rejects(p, (e: any) => e instanceof RecordPdfError && e.status === status && message.test(e.message));
const isPdf = (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-";

// ---- wellness: standalone ------------------------------------------------------------------------

const wellnessDraft = { recordedAt: "2026-10-21T10:30:00+05:30", systolic: 120, diastolic: 80, heartRate: 72, weightKg: 62, heightCm: 165 };
const savedWellness = { ...wellnessColumns({ ...wellnessDraft, patientId: PATIENT, hospitalId: HOSPITAL }), Id: 9, PatientId: PATIENT, HospitalId: HOSPITAL, RecordedById: DOCTOR, IsDeleted: false };

test("a wellness check is previewed from the form's fields, and the PDF is the one it carries once saved", async () => {
    const svc = service({ wellnessRecord: async () => ({ row: savedWellness, parties: fixtureParties }) });
    const preview = await svc.preview({ ...ctx, type: "wellness", draft: wellnessDraft, staffUserId: DOCTOR });
    assert.equal(preview.hiType, "WellnessRecord");
    assert.equal(preview.draft, false);
    assert.ok(isPdf(preview.pdf.data));
    assert.match(pdfText(preview.pdf.data), /120\/80/);

    const saved = await svc.saved({ ...ctx, type: "wellness", id: "9" });
    const edit = await svc.preview({ ...ctx, type: "wellness", draft: wellnessDraft, recordId: "9" });
    assert.deepEqual(edit.pdf.data, saved.pdf.data, "previewing the saved record's own fields gives its PDF byte for byte");
    assert.deepEqual(preview.pdf.data, saved.pdf.data, "and a new record's preview is the PDF saving it would give");
    assert.equal(saved.reference, "WR-9");
});

test("a form that doesn't make a record yet says why, as a 422", async () => {
    const svc = service();
    await rejects(svc.preview({ ...ctx, type: "wellness", draft: { recordedAt: wellnessDraft.recordedAt } }), 422, /at least one measurement/);
    await rejects(svc.preview({ ...ctx, type: "immunization", draft: { administeredOn: "2026-10-20" } }), 422, /vaccineName/);
    await rejects(svc.preview({ ...ctx, type: "prescription", draft: { doctorId: DOCTOR, medications: [] } }), 422, /at least one medicine/);
    await rejects(svc.preview({ ...ctx, type: "clinical-note", draft: { notes: "  " } }), 422, /Write the note/);
});

// ---- prescription: the clinic's own PDF is what goes ---------------------------------------------

const rxDraft = {
    doctorId: DOCTOR, appointmentId: 101, notes: "Review in a week",
    diagnoses: [{ diagnosis: "Dental caries", diagnosisConceptId: "80967001" }],
    medications: [{ medication: "Amoxicillin 500 mg capsule", dosage: "500 mg", frequencyType: "1-0-1", durationUnit: "5 days", route: "Oral" }],
};

test("a prescription by a doctor previews as the clinic's own PDF of it, which is what ABDM gets once it is saved", async () => {
    const rendered: any[] = [];
    const out = await service({}, rendered).preview({ ...ctx, type: "prescription", draft: rxDraft });
    assert.equal(out.pdf.source, "signed-copy");
    assert.deepEqual(out.pdf.data, CLINIC_PDF);
    assert.equal(out.reference, "OP-101", "a visit's prescription travels in the visit's care context");
    assert.equal(out.recordKey, "prescription-preview");
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].PatientId, PATIENT);
    assert.equal(rendered[0].AppointmentId, 101);
    assert.equal(rendered[0].Medications[0].Medication, "Amoxicillin 500 mg capsule");
    assert.equal(rendered[0].Diagnoses[0].Diagnosis, "Dental caries");
});

test("a manual prescription (no doctor) has no clinic PDF: it previews as the PDF built from it", async () => {
    const rendered: any[] = [];
    const { doctorId: _d, appointmentId: _a, ...manual } = rxDraft;
    const out = await service({}, rendered).preview({ ...ctx, type: "prescription", draft: manual });
    assert.equal(rendered.length, 0);
    assert.equal(out.pdf.source, "generated");
    assert.equal(out.reference, "RX-preview");
    assert.match(pdfText(out.pdf.data), /Amoxicillin 500 mg capsule/);
});

// ---- consultation and notes: inside the visit ----------------------------------------------------

test("a consultation is previewed inside its visit, with the visit's other records; vitals become its wellness record", async () => {
    const svc = service({ visit: async () => visit({ notes: [{ id: 5, text: "Advised warm saline rinses.", at: day }] }) });
    const op = await svc.preview({ ...ctx, type: "consultation", draft: { type: "Consultation", appointmentId: 101, chiefComplaint: "Swelling", diagnosis: "Dental abscess", doctorId: DOCTOR } });
    assert.equal(op.hiType, "OPConsultation");
    assert.equal(op.reference, "OP-101");
    const text = pdfText(op.pdf.data);
    assert.match(text, /Swelling/);
    assert.match(text, /Advised warm saline rinses/, "the visit's saved note is in it too, as it will be");

    const vitals = await svc.preview({ ...ctx, type: "consultation", draft: { type: "Vitals Check", appointmentId: 101, bloodPressure: "118/76" } });
    assert.equal(vitals.hiType, "WellnessRecord");
    assert.equal(vitals.recordKey, "appointment-101:wellness");

    const alone = await service().preview({ ...ctx, type: "consultation", draft: { type: "Consultation", chiefComplaint: "Swelling" } });
    assert.equal(alone.reference, "MR-preview", "outside a visit it is a care context of its own");
});

test("editing a visit's note previews the edited words in place of the saved ones", async () => {
    const svc = service({
        visit: async () => visit({ notes: [{ id: 5, text: "Advised warm saline rinses.", at: day }] }),
        clinicalNote: async () => ({ row: { Id: 5, PatientId: PATIENT, HospitalId: HOSPITAL, AppointmentId: 101, CreatedAt: day, Notes: "Advised warm saline rinses." }, parties: fixtureParties }),
    });
    const out = await svc.preview({ ...ctx, type: "clinical-note", recordId: "5", draft: { notes: "Review in a week." } });
    const text = pdfText(out.pdf.data);
    assert.match(text, /Review in a week/);
    assert.doesNotMatch(text, /warm saline/);
});

// ---- immunization, report, discharge summary -----------------------------------------------------

test("a vaccine given at a visit previews as the visit's immunization record, and matches the saved one", async () => {
    const draft = { vaccineName: "Tetanus toxoid vaccine", administeredOn: "2026-10-20", doseNumber: 1, appointmentId: 101 };
    const row = { ...immunizationColumns({ ...draft, patientId: PATIENT, hospitalId: HOSPITAL }), Id: 7, PatientId: PATIENT, HospitalId: HOSPITAL, IsDeleted: false };
    const svc = service({
        visit: async () => visit({ immunizations: [row as any] }),
        immunization: async () => ({ row, parties: fixtureParties, certificates: new Map() }),
    });
    const edit = await svc.preview({ ...ctx, type: "immunization", recordId: "7", draft });
    const saved = await svc.saved({ ...ctx, type: "immunization", id: "7" });
    assert.equal(saved.recordKey, "appointment-101:immunizations");
    assert.deepEqual(edit.pdf.data, saved.pdf.data);
});

const reportDraft = {
    category: "Lab", testName: "Complete blood count", testConceptId: "58410-2", issuedAt: "2026-10-21T09:00:00+05:30",
    results: [{ name: "Haemoglobin", value: 10.2, unit: "g/dL", low: 12, high: 15 }], conclusion: "Mild anaemia.", status: "Draft",
};

test("a report saved as a Draft previews as it will be shared once Final; without a conclusion it says so", async () => {
    const out = await service().preview({ ...ctx, type: "diagnostic-report", draft: reportDraft });
    assert.equal(out.hiType, "DiagnosticReport");
    assert.match(pdfText(out.pdf.data), /Mild anaemia/);
    await rejects(service().preview({ ...ctx, type: "diagnostic-report", draft: { ...reportDraft, conclusion: "" } }), 422, /conclusion/);

    const row = { ...diagnosticReportColumns({ ...reportDraft, patientId: PATIENT, hospitalId: HOSPITAL } as any), Id: 4, PatientId: PATIENT, HospitalId: HOSPITAL, IsDeleted: false };
    const saved = await service({ diagnosticReport: async () => ({ row, parties: fixtureParties, document: null }) }).saved({ ...ctx, type: "diagnostic-report", id: "4" });
    assert.equal(saved.draft, true, "a saved Draft is shown as it will be, and marked a draft");
});

test("a discharge summary previews with its prescription's medicines", async () => {
    const svc = service({
        prescriptionParts: async () => ({ medications: [real.medication({ Id: "m1", Medication: "Ibuprofen 400 mg tablet", Dosage: "400 mg" })], diagnoses: [] }),
    });
    const out = await svc.preview({
        ...ctx, type: "discharge-summary",
        draft: { doctorId: DOCTOR, admittedAt: "2026-10-18T09:00:00+05:30", dischargedAt: "2026-10-20T09:00:00+05:30", diagnoses: [{ text: "Dental abscess" }], prescriptionId: "rx-9", carePlan: "Soft diet" },
    });
    assert.equal(out.hiType, "DischargeSummary");
    assert.match(pdfText(out.pdf.data), /Ibuprofen 400 mg tablet/);
});

// ---- invoice -------------------------------------------------------------------------------------

const draftBill = {
    AppointmentBillId: "b-1", AppointmentId: 101, PatientId: PATIENT, HospitalId: HOSPITAL, BillNumber: "DFT-000123", BillStatus: "Draft", CreatedAt: day,
    SubTotal: 500, DiscountAmount: 0, TotalAmount: 500, CgstAmount: 0, SgstAmount: 0, IgstAmount: 0, GstAmount: 0, IsDeleted: false,
    BillItems: [{ AppointmentBillItemId: "i-1", ItemType: "Consultation", ItemName: "Consultation fee", Quantity: 1, UnitPrice: 500, DiscountAmount: 0, GstAmount: 0, TotalAmount: 500 }],
};

test("a bill not issued yet previews as its invoice will be once issued; a bill outside a visit isn't shared", async () => {
    const out = await service({ bill: async () => draftBill }).preview({ ...ctx, type: "invoice", draft: {}, billId: "b-1" });
    assert.equal(out.hiType, "Invoice");
    assert.equal(out.draft, true);
    assert.match(pdfText(out.pdf.data), /assigned when issued/);
    await rejects(service({ bill: async () => ({ ...draftBill, AppointmentId: null }) }).preview({ ...ctx, type: "invoice", draft: {}, billId: "b-1" }), 422, /no visit/);
});

// ---- whose -------------------------------------------------------------------------------------

test("another patient's record or visit is not found here", async () => {
    const other = { ...savedWellness, PatientId: "11111111-2222-4333-8444-555555555555" };
    await rejects(service({ wellnessRecord: async () => ({ row: other, parties: fixtureParties }) }).saved({ ...ctx, type: "wellness", id: "9" }), 404, /isn't this patient's/);
    await rejects(service({ wellnessRecord: async () => ({ row: { ...savedWellness, HospitalId: 99 }, parties: fixtureParties }) }).saved({ ...ctx, type: "wellness", id: "9" }), 404, /isn't this patient's/);
    const elsewhere = { ...fixtureParties, organization: { ...fixtureParties.organization, id: 99 } };
    await rejects(service({ visit: async () => visit({ parties: elsewhere }) }).preview({ ...ctx, type: "prescription", draft: rxDraft }), 404, /visit isn't this patient's/);
});

test("record types and bundle ids", () => {
    assert.equal(isRecordPdfType("wellness"), true);
    assert.equal(isRecordPdfType("health-document"), false);
    assert.equal(bundleIdOf({ hiType: "WellnessRecord", recordKey: "wellness-record-9" }).length, 36);
});
