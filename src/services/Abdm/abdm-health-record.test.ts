import { test } from "node:test";
import assert from "node:assert/strict";
import { AbdmHealthRecordService, diagnosticKind, isVitalsRecord, visitRecordDate, visitSources } from "./abdm-health-record.service.js";
import type { VisitRecords } from "../../repositories/Abdm/abdm-health-record.repository.js";
import { documentContentType, fromDbClock, hasConsultationContent, stampedWithRow, visitStart } from "../../repositories/Abdm/abdm-health-record.repository.js";
import { codedText, distinctCoded } from "./fhir/fhir-common.js";
import { fixtureParties } from "./fhir/fhir-fixtures.js";
import { immunizationColumns } from "../Appointments/immunization.service.js";
import { checkDates, codedList, dischargeSummaryColumns } from "../Appointments/discharge-summary.service.js";

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
    notes: [{ text: "Advised warm saline rinses.", at: day }],
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
    assert.deepEqual(op.chiefComplaints.map((c: any) => [c.text, c.conceptId]), [["Toothache", "27355003"]]);
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

test("records saved outside a visit are shared on their own, each as the HI type it is", async () => {
    const rx = { row: { Id: "rx-9", Date: day, PrescriptionNumber: 4, CreatedAt: day }, parties: fixtureParties, pdf: null, diagnoses: [], medications: [{ id: "m-1", name: "Amoxicillin 500 mg capsule" }] };
    const records = {
        prescription: async () => rx,
        consultationRecord: async () => ({ row: { Id: "mr-9", Type: "consultation", Date: day, ChiefComplaint: "Toothache", Diagnosis: "Dental caries" }, parties: fixtureParties }),
        clinicalNote: async () => ({ row: { Id: 5, Notes: "Review in a week.", CreatedAt: day }, parties: fixtureParties }),
        standaloneDocument: async (id: number) => ({
            parties: fixtureParties,
            document: id === 404 ? null : { id: `medical-document-${id}`, title: "Report", category: id === 1 ? "Lab Report" : "Clinical", contentType: "application/pdf", data: pdf, createdAt: day },
        }),
    };
    const s = service(records);
    assert.deepEqual((await s.forPrescription("rx-9")).map((r) => r.hiType), ["Prescription"]);
    const consult = await s.forConsultationRecord("mr-9");
    assert.deepEqual(consult.map((r) => r.hiType), ["OPConsultation"]);
    const note = await s.forClinicalNote(5);
    assert.deepEqual(note.map((r) => r.hiType), ["OPConsultation"]);
    assert.notEqual(consult[0]!.bundle.id, note[0]!.bundle.id, "each record its own bundle");
    assert.deepEqual((await s.forDocument(1)).map((r) => r.hiType), ["DiagnosticReport"]);
    assert.deepEqual((await s.forDocument(2)).map((r) => r.hiType), ["HealthDocumentRecord"]);

    assert.deepEqual(await service({ ...records, prescription: async () => ({ ...rx, medications: [] }) }).forPrescription("rx-9"), [], "no medicines, no prescription");
    assert.deepEqual(await service({ ...records, clinicalNote: async () => ({ row: { Id: 5, Notes: "  ", CreatedAt: day }, parties: fixtureParties }) }).forClinicalNote(5), []);
    assert.deepEqual(await s.forDocument(404), [], "a file that can't be read is not sent empty");
});

test("a consultation record is shared on its own only when something is written or measured in it", () => {
    assert.equal(hasConsultationContent({ Type: "consultation", ChiefComplaint: "Toothache" }), true);
    assert.equal(hasConsultationContent({ Type: "consultation", Weight: "62" }), true);
    assert.equal(hasConsultationContent({ Type: "consultation", ChiefComplaint: "  ", Diagnosis: "" }), false);
});

test("only an issued bill with items is an invoice", () => {
    const bill = visit().bills[0] as any;
    const invoices = (bills: any[]) => visitSources(visit({ bills })).filter((x) => x.hiType === "Invoice").length;
    assert.equal(invoices([bill, { ...bill, AppointmentBillId: "b2", BillStatus: "Paid" }]), 2);
    assert.equal(invoices([{ ...bill, BillStatus: "Draft" }]), 0);
    assert.equal(invoices([{ ...bill, BillItems: [] }]), 0, "a care context never claims an invoice it can't build");
});

test("a visit is dated by its earliest record: a bill paid today for tomorrow's appointment is today's", () => {
    const tomorrow = new Date("2026-10-27T09:30:00+05:30");
    const paidToday = new Date("2026-10-26T17:26:00+05:30");
    const v = visit({ appointment: { id: 342, start: tomorrow, end: null, teleconsultation: false }, medicalRecords: [], prescriptions: [], notes: [], documents: [], immunizations: [], bills: [{ ...(visit().bills[0] as any), CreatedAt: paidToday }] });
    assert.equal(visitRecordDate(v).getTime(), paidToday.getTime());
    assert.equal(visitRecordDate(visit({ immunizations: [] })).getTime(), day.getTime(), "otherwise the appointment");
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

test("a Final discharge summary can't be dated in the future; a Draft can", () => {
    const now = new Date("2026-10-26T12:30:00Z");
    const stay = (dischargedAt: string, Status: string) => ({ AdmittedAt: new Date("2026-10-26T06:00:00Z"), DischargedAt: new Date(dischargedAt), Status });
    assert.throws(() => checkDates(stay("2026-10-28T11:58:00Z", "Final"), now), /can't have a discharge date in the future/);
    assert.doesNotThrow(() => checkDates(stay("2026-10-28T11:58:00Z", "Draft"), now), "a planned discharge can wait as a Draft");
    assert.doesNotThrow(() => checkDates(stay("2026-10-26T12:00:00Z", "Final"), now));
    assert.doesNotThrow(() => checkDates(stay("2026-10-26T12:33:00Z", "Final"), now), "a desk clock a few minutes ahead");
    assert.throws(() => checkDates(stay("2026-10-26T05:00:00Z", "Draft"), now), /before admittedAt/);
});

test("a visit's records all carry the visit, and its consultation lists the prescriptions' diagnoses once", () => {
    const sources = visitSources(visit({
        prescriptions: [{
            row: { Id: "rx-1", Date: day, PrescriptionNumber: 1, CreatedAt: day } as any,
            medications: [{ id: "m-1", name: "Paracetamol 650 mg tablet", dosage: "650 mg" }],
            diagnoses: [{ text: "Dental caries", conceptId: "80967001" }, { text: "Gingivitis", conceptId: "66383009" }],
            pdf,
        }],
    }));
    assert.ok(sources.every((s) => (s.source as any).visit?.id === 101), "every source names visit 101");
    const op = sources.find((s) => s.hiType === "OPConsultation")!.source as any;
    assert.deepEqual(op.diagnoses.map((d: any) => d.text), ["Dental caries", "Gingivitis"], "the consultation's caries and the prescription's gingivitis, caries once");
});

test("a complaint written again as a symptom is one complaint; a different symptom is its own", async () => {
    const consultation = (Symptoms: string) => ({ Id: "mr-1", Type: "Consultation", Date: day, ChiefComplaint: "Fusion of teeth", Symptoms, Diagnosis: "Dental caries" } as any);
    const complaintsOf = (row: any) => (visitSources(visit({ medicalRecords: [row] })).find((s) => s.hiType === "OPConsultation")!.source as any)
        .chiefComplaints.map((c: any) => c.text);
    assert.deepEqual(complaintsOf(consultation("fusion of teeth")), ["Fusion of teeth"]);
    assert.deepEqual(complaintsOf(consultation("Pain on chewing")), ["Fusion of teeth", "Pain on chewing"]);

    const [own] = await service({ consultationRecord: async () => ({ row: consultation("Fusion of teeth"), parties: fixtureParties }) }).forConsultationRecord("mr-1");
    const conditions = own!.bundle.entry.map((e: any) => e.resource).filter((r: any) => r.resourceType === "Condition" && r.code?.text === "Fusion of teeth");
    assert.equal(conditions.length, 1, "a consultation saved on its own lists it once too");
});

const resourcesOf = (bundle: any, type: string) => bundle.entry.map((e: any) => e.resource).filter((r: any) => r.resourceType === type);

test("each medicine treats its own prescription's diagnoses, and is dated by it, in the consultation as in the prescription", async () => {
    const later = new Date("2026-10-20T10:35:00+05:30");
    const v = visit({
        medicalRecords: [{ Id: "mr-1", Type: "Consultation", Date: day, ChiefComplaint: "Sneezing", Diagnosis: "Allergic rhinitis caused by pollen", DiagnosisConceptId: "21719001" } as any],
        prescriptions: [
            { row: { Id: "rx-1", Date: later, PrescriptionNumber: 1, CreatedAt: later } as any, medications: [{ id: "m-1", name: "Dolo 650 tablet", dosage: "650 mg" }], diagnoses: [{ text: "Fever", conceptId: "386661006" }], pdf },
            { row: { Id: "rx-2", Date: later, PrescriptionNumber: 2, CreatedAt: later } as any, medications: [{ id: "m-2", name: "Cetirizine 10 mg tablet", dosage: "10 mg" }], diagnoses: [], pdf },
        ],
        documents: [], bills: [], immunizations: [],
    });
    const built = await service({ visit: async () => v }).forAppointment(101);
    const op = built.find((b) => b.hiType === "OPConsultation")!.bundle;
    const reasonOf = (bundle: any, id: string) => resourcesOf(bundle, "MedicationRequest").find((m: any) => m.text.div.includes(id)).reasonCode.map((c: any) => c.text);
    assert.deepEqual(reasonOf(op, "Dolo"), ["Fever"], "its prescription's own diagnosis, not the consultation's first");
    assert.deepEqual(reasonOf(op, "Cetirizine"), ["Allergic rhinitis caused by pollen"], "a prescription naming none treats the consultation's");
    const [rx1, rx2] = built.filter((b) => b.hiType === "Prescription").map((b) => b.bundle);
    assert.deepEqual(reasonOf(rx1, "Dolo"), ["Fever"]);
    assert.deepEqual(reasonOf(rx2, "Cetirizine"), ["Allergic rhinitis caused by pollen"], "no NA reason line where the visit says what it treats");
    assert.equal(resourcesOf(op, "MedicationRequest")[0].authoredOn, "2026-10-20T10:35:00+05:30", "the prescription's time, not the visit's");
    const diagnosisSection = (op.entry[0]!.resource as any).section.find((x: any) => x.title === "Diagnosis");
    assert.equal(diagnosisSection.entry.length, 2, "the visit's diagnoses are listed where a PHR app shows them");
});

test("a treatment plan is the doctor's words in Other observations, not a completed procedure", () => {
    const op = visitSources(visit({ medicalRecords: [{ Id: "mr-1", Type: "Consultation", Date: day, ChiefComplaint: "Toothache", Treatment: "Scaling next week" } as any] }))
        .find((x) => x.hiType === "OPConsultation")!.source as any;
    assert.deepEqual(op.procedures, []);
    assert.deepEqual(op.treatmentPlans, ["Scaling next week"]);
});

test("a visit's records are dated by their earliest part, which can come before the slot", () => {
    const slot = new Date("2026-10-20T17:00:00+05:30");
    const saved = new Date("2026-10-20T11:00:00+05:30");
    const sources = visitSources(visit({
        appointment: { id: 101, start: slot, end: null, teleconsultation: false },
        medicalRecords: [{ Id: "mr-1", Type: "Consultation", Date: saved, ChiefComplaint: "Toothache" } as any],
        prescriptions: [],
        notes: [],
        documents: [{ id: "d-3", title: "Referral letter", category: "Clinical", contentType: "application/pdf", data: pdf, createdAt: saved }],
        immunizations: [{ Id: 7, VaccineName: "Tetanus toxoid vaccine", AdministeredOn: "2026-10-20", DoseNumber: 1 } as any],
    }));
    const dateOf = (t: string) => (sources.find((x) => x.hiType === t)!.source as any).date.getTime();
    assert.equal(dateOf("OPConsultation"), saved.getTime());
    assert.equal(dateOf("HealthDocumentRecord"), saved.getTime());
    assert.equal(dateOf("ImmunizationRecord"), new Date(2026, 9, 20).getTime(), "the day it was given, from its start here");
});

test("every set of vitals of a visit is shown, and a finding written twice once", () => {
    const op = visitSources(visit({
        medicalRecords: [
            { Id: "mr-1", Type: "Consultation", Date: day, BloodPressure: "120/80", PhysicalExamination: "Caries" } as any,
            { Id: "mr-2", Type: "Consultation", Date: new Date(day.getTime() + 3_600_000), BloodPressure: "130/85", PhysicalExamination: "caries" } as any,
        ],
    })).find((x) => x.hiType === "OPConsultation")!.source as any;
    assert.deepEqual(op.vitalReadings.map((r: any) => r.vitals.bloodPressure), ["120/80", "130/85"]);
    assert.deepEqual(op.examinationFindings.map((f: any) => f.text), ["Caries"]);
});

test("a bill still numbered DFT- has not been issued and is not an invoice", () => {
    const bill = visit().bills[0] as any;
    const invoices = (bills: any[]) => visitSources(visit({ bills })).filter((x) => x.hiType === "Invoice").length;
    assert.equal(invoices([{ ...bill, BillStatus: "Paid", BillNumber: "DFT-123456-7890" }]), 0);
    assert.equal(invoices([{ ...bill, BillStatus: "Pending", BillNumber: null }]), 0);
    assert.equal(invoices([bill]), 1);
});

test("a visit's vaccines carry each certificate once and who gave them only when recorded", () => {
    const cert = (id: number) => ({ id: `medical-document-${id}`, title: `Certificate ${id}`, contentType: "application/pdf", data: pdf, createdAt: day });
    const im = visitSources(visit({
        immunizations: [
            { Id: 7, VaccineName: "Tetanus toxoid vaccine", AdministeredOn: "2026-10-20", CertificateDocumentId: 11, DoctorId: "D-1" } as any,
            { Id: 8, VaccineName: "Hepatitis B vaccine", AdministeredOn: "2026-10-20", CertificateDocumentId: 12 } as any,
            { Id: 9, VaccineName: "Influenza vaccine", AdministeredOn: "2026-10-20", CertificateDocumentId: 11 } as any,
        ],
        certificates: new Map([[11, cert(11)], [12, cert(12)]]),
        givenBy: new Map([["d-1", { id: "D-1", name: "Dr. Given" }]]),
    })).find((x) => x.hiType === "ImmunizationRecord")!.source as any;
    assert.deepEqual(im.certificates.map((c: any) => c.title), ["Certificate 11", "Certificate 12"]);
    assert.deepEqual(im.immunizations.map((i: any) => i.performer?.name ?? null), ["Dr. Given", null, null]);
});

test("chip fields split into one concept per chip, and a made-up id is dropped, its words kept", () => {
    assert.deepEqual(codedText("Toothache, Fever", "27355003,386661006"), [{ text: "Toothache", conceptId: "27355003" }, { text: "Fever", conceptId: "386661006" }]);
    assert.deepEqual(codedText("Fusion of teeth", "custom-1729998000000"), [{ text: "Fusion of teeth", conceptId: null }]);
    assert.deepEqual(codedText("Toothache, Fever, since two days", "27355003,386661006"), [
        { text: "Toothache", conceptId: "27355003" }, { text: "Fever", conceptId: "386661006" }, { text: "since two days", conceptId: null }]);
    assert.deepEqual(codedText("Toothache", "27355003,386661006"), [{ text: "Toothache", conceptId: null }], "ids that can't be paired: the words alone");
    assert.deepEqual(distinctCoded([{ text: "fever" }, { text: "Fever", conceptId: "386661006" }, { text: " FEVER " }]), [{ text: "Fever", conceptId: "386661006" }]);
});

test("a time the database stamped is read as the instant it was; one the app wrote is kept", () => {
    // The driver reads the UTC wall clock 06:20 as 06:20 here; it was 11:50 IST
    const read = new Date(2026, 9, 28, 6, 20, 11);
    assert.equal(fromDbClock(read).toISOString(), "2026-10-28T06:20:11.000Z");
    const createdAt = new Date(2026, 9, 28, 5, 53, 53);
    assert.equal(stampedWithRow(new Date(2026, 9, 28, 5, 53, 53, 400), createdAt), true, "Date and CreatedAt both the default");
    assert.equal(stampedWithRow(new Date(2026, 9, 28, 11, 23, 53), createdAt), false, "a vitals check the app stamped in IST");
});

test("a visit note dates the visit by when it was written, and its observation by its own time", async () => {
    const slot = new Date("2026-08-13T09:00:00+05:30");
    const written = new Date("2026-08-12T17:07:56+05:30");
    const v = visit({ appointment: { id: 239, start: slot, end: null, teleconsultation: false }, medicalRecords: [], prescriptions: [], documents: [], bills: [], immunizations: [],
        notes: [{ text: "Summary of the booking call.", at: written }] });
    const op = visitSources(v).find((x) => x.hiType === "OPConsultation")!.source as any;
    assert.equal(op.date.getTime(), written.getTime());
    assert.equal(visitRecordDate(v).getTime(), written.getTime());
    const [built] = await service({ visit: async () => v }).forAppointment(239);
    const note = resourcesOf(built!.bundle, "Observation").find((o: any) => o.valueString === "Summary of the booking call.");
    assert.equal(note.effectiveDateTime, "2026-08-12T17:07:56+05:30");
});

test("a prescription without medicines still gives the consultation its diagnoses and notes", async () => {
    const v = visit({
        medicalRecords: [{ Id: "mr-1", Type: "Consultation", Date: day, ChiefComplaint: "Toothache" } as any],
        prescriptions: [{ row: { Id: "rx-3", Date: day, PrescriptionNumber: 3, CreatedAt: day, Notes: "Review in a week" } as any, medications: [], diagnoses: [{ text: "Dental caries", conceptId: "80967001" }], pdf }],
        documents: [], bills: [], immunizations: [],
    });
    const sources = visitSources(v);
    assert.ok(!sources.some((x) => x.hiType === "Prescription"), "no medicines, no Prescription record");
    const [built] = await service({ visit: async () => v }).forAppointment(101, ["OPConsultation"]);
    const c = built!.bundle.entry[0]!.resource as any;
    assert.deepEqual(c.section.find((x: any) => x.title === "Diagnosis").entry.map((e: any) => e.display), ["Dental caries"]);
    assert.ok(resourcesOf(built!.bundle, "Observation").some((o: any) => o.valueString === "Review in a week"));
});

test("a consultation lists a prescription's notes only when its medicines' advice does not already say them, word for word", async () => {
    const withNotes = (Notes: string, Instructions: string) => visit({
        medicalRecords: [{ Id: "mr-1", Type: "Consultation", Date: day, ChiefComplaint: "Toothache" } as any],
        prescriptions: [{ row: { Id: "rx-5", Date: day, PrescriptionNumber: 5, CreatedAt: day, Notes } as any,
            medications: [{ id: "m-5", name: "Ibuprofen 400 mg tablet", instructions: Instructions, prescriptionNotes: Notes.trim() }], diagnoses: [], pdf }],
        documents: [], bills: [], immunizations: [], notes: [],
    });
    const noteObservations = async (v: VisitRecords) => resourcesOf((await service({ visit: async () => v }).forAppointment(101, ["OPConsultation"]))[0]!.bundle, "Observation")
        .filter((o: any) => o.code.text === "Prescription notes").map((o: any) => o.valueString);
    assert.deepEqual(await noteObservations(withNotes("Drink water. ", "Drink water")), [], "already in the advice");
    assert.deepEqual(await noteObservations(withNotes("Ice", "Twice daily after food")), ["Ice"], "not a word of the advice");
});
