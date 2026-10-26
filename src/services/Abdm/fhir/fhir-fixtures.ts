import type { HiType } from "./fhir-common.js";
import type { RecordSourceFor } from "./health-records.js";
import type { RecordParties } from "./fhir-sources.js";

/**
 * One fictitious record of each HI type, for the builder tests and for `npm run fhir:validate`.
 * No real patient: the ABHA number and address are made up, and the "PDF" is a few bytes.
 */

const at = (iso: string) => new Date(iso);
const pdf = Buffer.from("%PDF-1.4\n% fixture\n");

export const fixtureParties: RecordParties = {
    patient: {
        id: "0f6c2b8e-1d2a-4c55-9d7e-0a1b2c3d4e5f",
        name: "Asha <Test> & Rao",
        gender: "Female",
        birthDate: "1990-04-12",
        phone: "+919800000000",
        abhaNumber: "91-0000-0000-0000",
        abhaAddress: "asha.test@sbx",
    },
    practitioner: { id: "7a1e3c55-2b4d-4e6f-8a9b-0c1d2e3f4a5b", name: "Dr. Kiran Test", registrationNumber: "TSMC-12345", qualification: "BDS" },
    organization: { id: 12, name: "Ocimum Dental Clinic", hfrId: "IN3610001937", phone: "+914000000000" },
};

export const FIXTURES: { [T in HiType]: RecordSourceFor[T] } = {
    OPConsultation: {
        ...fixtureParties,
        visit: { id: 101, start: at("2026-10-20T10:00:00+05:30"), end: at("2026-10-20T10:20:00+05:30"), teleconsultation: false },
        chiefComplaints: [{ text: "Toothache", conceptId: "27355003" }],
        examinationFindings: [{ text: "Dental caries", conceptId: "80967001" }],
        vitals: { bloodPressure: "120/80", heartRate: "72", temperature: "98.4", weight: "62", height: "165" },
        allergies: "Penicillin",
        medicalHistory: "Type 2 diabetes for 5 years",
        diagnoses: [{ text: "Dental caries", conceptId: "80967001" }],
        procedures: [{ text: "Scaling of teeth" }],
        medications: [{ id: "m-1", name: "Paracetamol 650 mg tablet", dosage: "650 mg", frequency: "Twice daily", duration: "3 days", route: "Oral" }],
        notes: ["Advised warm saline rinses."],
        followUp: at("2026-10-27T10:00:00+05:30"),
        documents: [{ id: "doc-op-1", title: "Intraoral photo", category: "Clinical", contentType: "application/pdf", data: pdf, createdAt: at("2026-10-20T10:15:00+05:30") }],
    },
    Prescription: {
        ...fixtureParties,
        prescription: {
            id: "rx-1",
            number: 42,
            date: at("2026-10-20T10:18:00+05:30"),
            diagnoses: [{ text: "Dental caries", conceptId: "80967001" }],
            medications: [
                { id: "rx-1-m-1", name: "Amoxicillin 500 mg capsule", dosage: "500 mg", frequency: "Three times daily", duration: "5 days", route: "Oral" },
                { id: "rx-1-m-2", name: "Paracetamol 650 mg tablet", dosage: "650 mg", frequency: "When needed", route: "Oral", instructions: "After food" },
            ],
            signedCopy: { contentType: "application/pdf", data: pdf },
        },
    },
    DiagnosticReport: {
        ...fixtureParties,
        kind: "lab",
        report: { id: "doc-lab-1", title: "Complete blood count", category: "Lab", contentType: "application/pdf", data: pdf, createdAt: at("2026-10-19T09:00:00+05:30") },
    },
    DischargeSummary: {
        ...fixtureParties,
        summary: {
            id: "ds-1",
            admittedAt: at("2026-10-10T09:00:00+05:30"),
            dischargedAt: at("2026-10-12T17:00:00+05:30"),
            chiefComplaints: [{ text: "Facial swelling" }],
            allergies: "Penicillin",
            medicalHistory: [{ text: "Type 2 diabetes" }],
            examinationFindings: [{ text: "Swelling of the left cheek" }],
            diagnoses: [{ text: "Dental abscess" }],
            investigations: "Orthopantomogram: periapical radiolucency at 36.",
            procedures: [{ text: "Incision and drainage of abscess" }],
            medications: [{ id: "ds-1-m-1", name: "Amoxicillin 500 mg capsule", dosage: "500 mg", frequency: "Three times daily", duration: "5 days", route: "Oral" }],
            carePlan: "Soft diet. Continue antibiotics.",
            followUp: at("2026-10-19T10:00:00+05:30"),
            disposition: "Discharged home",
        },
        document: { id: "doc-ds-1", title: "Discharge summary", contentType: "application/pdf", data: pdf, createdAt: at("2026-10-12T17:00:00+05:30") },
    },
    ImmunizationRecord: {
        ...fixtureParties,
        key: "immunizations-1",
        date: at("2026-10-20T11:00:00+05:30"),
        immunizations: [{
            id: "im-1",
            vaccine: { text: "Tetanus toxoid vaccine" },
            date: "2026-10-20",
            doseNumber: 1,
            lotNumber: "TT-2026-001",
            manufacturer: "Test Biologicals",
            route: "Intramuscular",
            site: "Left deltoid",
            nextDueDate: "2026-11-20",
        }],
        certificate: { id: "doc-im-1", title: "Vaccination certificate", contentType: "application/pdf", data: pdf, createdAt: at("2026-10-20T11:00:00+05:30") },
    },
    HealthDocumentRecord: {
        ...fixtureParties,
        key: "appointment-101:documents",
        date: at("2026-10-20T10:00:00+05:30"),
        title: "Health documents",
        documents: [{ id: "doc-h-1", title: "Old discharge card", category: "Other", contentType: "application/pdf", data: pdf, createdAt: at("2026-10-18T12:00:00+05:30") }],
    },
    WellnessRecord: {
        ...fixtureParties,
        key: "wellness-2026-10-20",
        date: at("2026-10-20T08:00:00+05:30"),
        measurements: [
            { kind: "bloodPressure", systolic: 118, diastolic: 76, at: at("2026-10-20T08:00:00+05:30") },
            { kind: "heartRate", value: 70, at: at("2026-10-20T08:00:00+05:30") },
            { kind: "oxygenSaturation", value: 98, at: at("2026-10-20T08:00:00+05:30") },
            { kind: "weight", value: 61.5, at: at("2026-10-20T08:00:00+05:30") },
            { kind: "steps", value: 8400, at: at("2026-10-20T23:59:00+05:30") },
            { kind: "sleepHours", value: 7.2, at: at("2026-10-20T07:00:00+05:30") },
            { kind: "bloodGlucose", value: 104, at: at("2026-10-20T08:00:00+05:30") },
        ],
    },
    Invoice: {
        ...fixtureParties,
        bill: {
            id: "bill-1",
            number: "INV-2026-0001",
            date: at("2026-10-20T10:25:00+05:30"),
            status: "Paid",
            subTotal: 1500,
            discount: 100,
            total: 1652,
            cgst: 126,
            sgst: 126,
            igst: 0,
            items: [
                { id: "item-1", type: "Consultation", name: "Consultation fee", quantity: 1, unitPrice: 500, discount: 0, gstAmount: 0, total: 500 },
                { id: "item-2", type: "TreatmentPlan", name: "Scaling and polishing", quantity: 1, unitPrice: 1000, discount: 100, gstAmount: 252, total: 1152 },
            ],
        },
    },
};
