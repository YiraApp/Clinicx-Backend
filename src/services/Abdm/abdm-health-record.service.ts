import { FhirSourceError, codedText, distinctCoded, fhirDate, type FhirBundle, type HiType } from "./fhir/fhir-common.js";
import { BUILDERS, type RecordSourceFor } from "./fhir/health-records.js";
import type { CodedText, DiagnosticKind, DocumentSource, RecordParties, VisitVitals, WellnessMeasurement } from "./fhir/fhir-sources.js";
import { visitVitalsToMeasurements } from "./fhir/measurements.js";
import { abdmHealthRecordRepository, isVitalsRecord, type AbdmHealthRecordRepository, type VisitRecords } from "../../repositories/Abdm/abdm-health-record.repository.js";
import type { PatientMedicalRecord } from "../../models/Appointments/patient-medical-record.model.js";
import { bmiOf } from "../Appointments/wellness-record.service.js";
import type { ReportResult } from "../Appointments/diagnostic-report.service.js";

/**
 * Which ABDM health records a care context holds, built as NRCES bundles. A visit (an appointment)
 * can hold all eight HI types; every record saved outside a visit (a discharge summary, an
 * immunization, a vitals check, a prescription, a consultation record, a clinical note, an
 * uploaded document) is a care context of its own. A type with nothing recorded is not offered,
 * never sent empty.
 */

export interface HealthRecordBundle {
    hiType: HiType;
    /** Stable within the care context: the record's own id. */
    key: string;
    bundle: FhirBundle;
}

type SourceOf = { [T in HiType]: { hiType: T; source: RecordSourceFor[T] } }[HiType];

export { isVitalsRecord } from "../../repositories/Abdm/abdm-health-record.repository.js";

/** Lab and imaging uploads are diagnostic reports; any other upload is a health document. */
export const diagnosticKind = (category?: string | null): DiagnosticKind | null => {
    const c = category ?? "";
    if (/lab|patholog/i.test(c)) return "lab";
    if (/imag|radiolog|x-?ray|scan|mri|ultrasound|\bct\b/i.test(c)) return "imaging";
    return null;
};

const vitalsOf = (r: PatientMedicalRecord): VisitVitals => ({
    bloodPressure: r.BloodPressure, heartRate: r.HeartRate, temperature: r.Temperature, weight: r.Weight, height: r.Height, spo2: r.SpO2,
});
const hasVitals = (r: PatientMedicalRecord) => Boolean(r.BloodPressure || r.HeartRate || r.Temperature || r.Weight || r.Height || r.SpO2);

/** What one field of a record names, each concept dated when the record was saved. */
const recordedIn = (at: Date, text?: string | null, conceptIds?: string | null): CodedText[] =>
    codedText(text, conceptIds).map((c) => ({ ...c, recordedAt: at }));

/** The earliest of these times: a record is dated by its first part, which may come before the slot it was booked for. */
const earliest = (...dates: Array<Date | string | null | undefined>): Date =>
    new Date(Math.min(...dates.map((d) => (d ? new Date(d).getTime() : NaN)).filter((t) => !Number.isNaN(t))));

/** A date the clinic keeps without a time ("2026-10-20"), as the start of that day here. */
const startOfDay = (d: Date | string): Date => {
    const [y, m, day] = fhirDate(d).split("-").map(Number);
    return new Date(y!, m! - 1, day!);
};

type VisitPrescription = VisitRecords["prescriptions"][number];
const prescriptionDate = (p: VisitPrescription, fallback: Date): Date => p.row.Date ?? p.row.CreatedAt ?? fallback;

/** [reasons]: the diagnoses its medicines treat, its own unless it names none. */
const prescriptionSource = (parties: RecordParties, p: VisitPrescription, fallbackDate: Date, reasons: CodedText[] = p.diagnoses): SourceOf => ({
    hiType: "Prescription",
    source: {
        ...parties,
        // Its prescriber, when another of the hospital's doctors wrote it
        ...(p.practitioner ? { practitioner: p.practitioner } : {}),
        prescription: {
            id: p.row.Id,
            number: p.row.PrescriptionNumber ?? null,
            date: prescriptionDate(p, fallbackDate),
            notes: p.row.Notes ?? null,
            diagnoses: distinctCoded(reasons),
            medications: p.medications,
            signedCopy: p.pdf ? { contentType: "application/pdf", data: p.pdf } : null,
        },
    },
});

/** A document as the HI type it is: lab and imaging uploads are diagnostic reports, any other a health document. */
const documentSource = (parties: RecordParties, d: DocumentSource, key: string): SourceOf => {
    const kind = diagnosticKind(d.category);
    return kind
        ? { hiType: "DiagnosticReport", source: { ...parties, kind, document: d } }
        : { hiType: "HealthDocumentRecord", source: { ...parties, key, date: d.createdAt, title: "Health document", documents: [d] } };
};

const INVOICEABLE = new Set(["Pending", "PartiallyPaid", "Paid"]);
/** Issued: a bill with an invoice number. One still numbered DFT- has not been through Generate Invoice. */
const issuedBill = (b: { BillStatus: string; BillNumber?: string | null }) =>
    INVOICEABLE.has(b.BillStatus) && Boolean(b.BillNumber) && !b.BillNumber!.startsWith("DFT-");

/**
 * When a visit's records start: the appointment, or an earlier record made for it (a bill paid in
 * advance). ABDM shares a care context only inside the consented date range, which ends when the
 * patient consents, so a visit booked for tomorrow with a bill paid today is dated today.
 */
export const visitRecordDate = (v: VisitRecords): Date => {
    const dates = [
        v.appointment.start,
        ...v.medicalRecords.map((r) => r.Date),
        ...v.notes.map((n) => n.at),
        ...v.prescriptions.map((p) => p.row.Date ?? p.row.CreatedAt),
        ...v.documents.map((d) => d.createdAt),
        ...v.bills.map((b) => b.CreatedAt),
        ...v.immunizations.map((i) => (i.AdministeredOn ? startOfDay(i.AdministeredOn) : null)),
    ].map((d) => (d ? new Date(d) : null)).filter((d): d is Date => d !== null && !Number.isNaN(d.getTime()));
    return new Date(Math.min(...dates.map((d) => d.getTime())));
};

/** The records one visit holds, as builder sources. Pure: everything it needs is in [v]. */
export const visitSources = (v: VisitRecords): SourceOf[] => {
    const out: SourceOf[] = [];
    const visitKey = `appointment-${v.appointment.id}`;
    const slot = v.appointment.start;
    const visit = { id: v.appointment.id, start: slot, end: v.appointment.end, teleconsultation: v.appointment.teleconsultation };
    // Every record of the visit carries it, so they share one encounter
    const parties = { ...v.parties, visit };
    const consultations = v.medicalRecords.filter((r) => !isVitalsRecord(r));
    const vitalsChecks = v.medicalRecords.filter(isVitalsRecord);
    const at = (r: PatientMedicalRecord) => new Date(r.Date);
    // A prescription treats its own diagnoses, or, when it names none, the consultation's
    const consultationDiagnoses = distinctCoded(consultations.flatMap((r) => recordedIn(at(r), r.Diagnosis, r.DiagnosisConceptId)));
    const reasonsOf = (p: VisitPrescription): CodedText[] =>
        p.diagnoses.length ? distinctCoded(p.diagnoses.map((d) => ({ ...d, recordedAt: prescriptionDate(p, slot) }))) : consultationDiagnoses;
    const prescribed = v.prescriptions.filter((p) => p.medications.length);

    if (consultations.length || v.notes.length || v.prescriptions.length) {
        const withVitals = consultations.filter(hasVitals);
        const followUps = consultations.map((r) => r.FollowUpDate).filter((d): d is Date => Boolean(d));
        out.push({
            hiType: "OPConsultation",
            source: {
                ...parties,
                date: earliest(slot, ...consultations.map(at), ...v.prescriptions.map((p) => prescriptionDate(p, slot)), ...v.notes.map((n) => n.at)),
                // Complaint and symptoms are one list: the same words in both are one complaint
                chiefComplaints: distinctCoded(consultations.flatMap((r) => [
                    ...recordedIn(at(r), r.ChiefComplaint, r.ChiefComplaintConceptId), ...recordedIn(at(r), r.Symptoms, r.SymptomConceptId),
                ])),
                examinationFindings: distinctCoded(consultations.flatMap((r) => recordedIn(at(r), r.PhysicalExamination, r.PhysicalExaminationConceptId))),
                vitals: withVitals[0] ? vitalsOf(withVitals[0]) : null,
                vitalsRecordedAt: withVitals[0] ? at(withVitals[0]) : null,
                vitalReadings: withVitals.map((r) => ({ vitals: vitalsOf(r), at: at(r) })),
                allergies: v.registration.allergies,
                medicalHistory: v.registration.medicalHistory,
                // The consultation's diagnoses and its prescriptions' (one without medicines too), which the medicines are for
                diagnoses: distinctCoded([...consultationDiagnoses, ...v.prescriptions.flatMap(reasonsOf)]),
                procedures: [],
                treatmentPlans: consultations.map((r) => r.Treatment?.trim()).filter((t): t is string => Boolean(t)),
                medications: prescribed.flatMap((p) => p.medications),
                // Every prescription of the visit: one without medicines still has its notes
                prescriptions: v.prescriptions.map((p) => ({
                    date: prescriptionDate(p, slot), diagnoses: reasonsOf(p), medications: p.medications, practitioner: p.practitioner ?? null, notes: p.row.Notes ?? null,
                })),
                authoredOn: v.prescriptions[0] ? prescriptionDate(v.prescriptions[0], slot) : null,
                notes: v.notes.map((n) => n.text),
                noteTimes: v.notes.map((n) => n.at),
                followUp: followUps.length ? new Date(Math.max(...followUps.map((d) => new Date(d).getTime()))) : null,
                documents: [],
            },
        });
    }

    for (const p of prescribed) out.push(prescriptionSource(parties, p, slot, reasonsOf(p)));

    const healthDocuments = [];
    for (const d of v.documents) {
        const kind = diagnosticKind(d.category);
        if (kind) out.push({ hiType: "DiagnosticReport", source: { ...parties, kind, document: d } });
        else healthDocuments.push(d);
    }
    if (healthDocuments.length) {
        out.push({
            hiType: "HealthDocumentRecord",
            source: { ...parties, key: `${visitKey}:documents`, date: earliest(slot, ...healthDocuments.map((d) => d.createdAt)), title: "Health documents", documents: healthDocuments },
        });
    }

    const measurements: WellnessMeasurement[] = vitalsChecks.flatMap((r) => visitVitalsToMeasurements(vitalsOf(r), at(r)));
    if (measurements.length) {
        out.push({ hiType: "WellnessRecord", source: { ...parties, key: `${visitKey}:wellness`, date: earliest(slot, ...vitalsChecks.map(at)), measurements } });
    }

    for (const b of v.bills) {
        // Only an issued bill with items is an invoice: a care context never claims one it can't build
        if (!issuedBill(b) || !(b.BillItems ?? []).length) continue;
        out.push({
            hiType: "Invoice",
            source: {
                ...parties,
                bill: {
                    id: b.AppointmentBillId,
                    number: b.BillNumber,
                    date: b.CreatedAt,
                    status: b.BillStatus,
                    subTotal: Number(b.SubTotal), discount: Number(b.DiscountAmount), total: Number(b.TotalAmount),
                    cgst: Number(b.CgstAmount), sgst: Number(b.SgstAmount), igst: Number(b.IgstAmount), gst: Number(b.GstAmount ?? 0),
                    items: (b.BillItems ?? []).map((i) => ({
                        id: i.AppointmentBillItemId, type: i.ItemType, name: i.ItemName, quantity: Number(i.Quantity),
                        unitPrice: Number(i.UnitPrice), discount: Number(i.DiscountAmount), gstAmount: Number(i.GstAmount), total: Number(i.TotalAmount),
                    })),
                },
            },
        });
    }

    if (v.immunizations.length) {
        // Each vaccine's certificate, each file once
        const certificateIds = [...new Set(v.immunizations.map((i) => i.CertificateDocumentId).filter((id): id is number => Boolean(id)))];
        out.push({
            hiType: "ImmunizationRecord",
            source: {
                ...parties,
                key: `${visitKey}:immunizations`,
                // Dated when the vaccines were given, which can be before the slot; a dose given long ago dates nothing later
                date: earliest(slot, new Date(Math.max(...v.immunizations.map((i) => startOfDay(i.AdministeredOn).getTime())))),
                immunizations: v.immunizations.map((i) => ({
                    id: `patient-immunization-${i.Id}`,
                    vaccine: { text: i.VaccineName, conceptId: i.VaccineConceptId },
                    date: i.AdministeredOn,
                    doseNumber: i.DoseNumber, lotNumber: i.LotNumber, manufacturer: i.Manufacturer, route: i.Route, site: i.Site,
                    nextDueDate: i.NextDueDate, notes: i.Notes,
                    performer: (i.DoctorId && v.givenBy?.get(i.DoctorId.toLowerCase())) || null,
                })),
                certificates: certificateIds.map((id) => v.certificates.get(id)).filter((d): d is DocumentSource => Boolean(d)),
            },
        });
    }
    return out;
};

const parseList = (json?: string | null): CodedText[] => {
    if (!json) return [];
    try {
        const items = JSON.parse(json);
        return Array.isArray(items) ? items.filter((i) => i?.text).map((i) => ({ text: String(i.text), conceptId: i.conceptId ?? null })) : [];
    } catch {
        return [];
    }
};

export class AbdmHealthRecordService {
    constructor(
        private readonly records: Pick<AbdmHealthRecordRepository,
            "visit" | "dischargeSummary" | "immunization" | "vitalsRecord" | "prescription" | "consultationRecord" | "clinicalNote" | "standaloneDocument"
            | "diagnosticReport" | "wellnessRecord"> = abdmHealthRecordRepository,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async forAppointment(appointmentId: number, hiTypes?: HiType[]): Promise<HealthRecordBundle[]> {
        return this.build(visitSources(await this.records.visit(appointmentId)), hiTypes);
    }

    /** A Final discharge summary; a draft is not shared. */
    async forDischargeSummary(id: number): Promise<HealthRecordBundle[]> {
        const { summary: s, parties, medications, prescriptionDiagnoses, document } = await this.records.dischargeSummary(id);
        if (s.Status !== "Final") return [];
        return this.build([{
            hiType: "DischargeSummary",
            source: {
                ...parties,
                summary: {
                    id: String(s.Id),
                    admittedAt: s.AdmittedAt,
                    dischargedAt: s.DischargedAt,
                    chiefComplaints: parseList(s.ChiefComplaints),
                    allergies: s.Allergies,
                    medicalHistory: parseList(s.MedicalHistory),
                    examinationFindings: parseList(s.ExaminationFindings),
                    diagnoses: parseList(s.Diagnoses),
                    investigations: s.Investigations,
                    procedures: parseList(s.Procedures),
                    medications,
                    prescriptionDiagnoses: prescriptionDiagnoses ?? [],
                    carePlan: s.CarePlan,
                    followUp: s.FollowUpDate ?? null,
                    disposition: s.Disposition,
                },
                document,
            },
        }]);
    }

    /** A vitals check outside a visit: a WellnessRecord of its own. */
    async forVitalsRecord(id: string): Promise<HealthRecordBundle[]> {
        const { row, parties } = await this.records.vitalsRecord(id);
        const measurements = visitVitalsToMeasurements(vitalsOf(row), new Date(row.Date));
        if (!measurements.length) return [];
        return this.build([{ hiType: "WellnessRecord", source: { ...parties, key: `vitals-${row.Id}`, date: new Date(row.Date), measurements } }]);
    }

    /** An immunization given outside a visit. */
    async forImmunization(id: number): Promise<HealthRecordBundle[]> {
        const { row: i, parties, certificates } = await this.records.immunization(id);
        return this.build([{
            hiType: "ImmunizationRecord",
            source: {
                ...parties,
                key: `immunization-${i.Id}`,
                date: startOfDay(i.AdministeredOn),
                immunizations: [{
                    id: `patient-immunization-${i.Id}`,
                    vaccine: { text: i.VaccineName, conceptId: i.VaccineConceptId },
                    date: i.AdministeredOn,
                    doseNumber: i.DoseNumber, lotNumber: i.LotNumber, manufacturer: i.Manufacturer, route: i.Route, site: i.Site,
                    nextDueDate: i.NextDueDate, notes: i.Notes,
                    // The record's author is the "Given by" doctor when one was recorded, the facility's staff otherwise
                    performer: i.DoctorId && parties.practitioner.id.toLowerCase() === i.DoctorId.toLowerCase() ? parties.practitioner : null,
                }],
                certificates: [i.CertificateDocumentId ? certificates.get(i.CertificateDocumentId) : undefined].filter((d): d is DocumentSource => Boolean(d)),
            },
        }]);
    }

    /** A prescription saved outside a visit. */
    async forPrescription(id: string): Promise<HealthRecordBundle[]> {
        const { row, parties, pdf, medications, diagnoses } = await this.records.prescription(id);
        if (!medications.length) return [];
        return this.build([prescriptionSource(parties, { row, medications, diagnoses, pdf }, row.CreatedAt ?? new Date())]);
    }

    /** A consultation record saved outside a visit: an OPConsultation of its own, dated when it was recorded. */
    async forConsultationRecord(id: string): Promise<HealthRecordBundle[]> {
        const { row: r, parties } = await this.records.consultationRecord(id);
        const date = new Date(r.Date);
        const vitals = vitalsOf(r);
        return this.build([{
            hiType: "OPConsultation",
            source: {
                ...parties,
                key: `medical-record-${r.Id}`,
                visit: { id: 0, start: date, end: null, teleconsultation: false },
                chiefComplaints: distinctCoded([...recordedIn(date, r.ChiefComplaint, r.ChiefComplaintConceptId), ...recordedIn(date, r.Symptoms, r.SymptomConceptId)]),
                examinationFindings: distinctCoded(recordedIn(date, r.PhysicalExamination, r.PhysicalExaminationConceptId)),
                vitals: Object.values(vitals).some(Boolean) ? vitals : null,
                vitalsRecordedAt: date,
                diagnoses: distinctCoded(recordedIn(date, r.Diagnosis, r.DiagnosisConceptId)),
                procedures: [],
                treatmentPlans: r.Treatment?.trim() ? [r.Treatment.trim()] : [],
                medications: [],
                notes: [],
                followUp: r.FollowUpDate ?? null,
                documents: [],
            },
        }]);
    }

    /** A clinical note written outside a visit: an OPConsultation holding the note. */
    async forClinicalNote(id: number): Promise<HealthRecordBundle[]> {
        const { row, parties } = await this.records.clinicalNote(id);
        if (!row.Notes?.trim()) return [];
        const date = new Date(row.CreatedAt);
        return this.build([{
            hiType: "OPConsultation",
            source: {
                ...parties,
                key: `clinical-note-${row.Id}`,
                visit: { id: 0, start: date, end: null, teleconsultation: false },
                chiefComplaints: [], examinationFindings: [], diagnoses: [], procedures: [], medications: [], documents: [],
                notes: [row.Notes],
            },
        }]);
    }

    /** A document the clinic uploaded outside a visit. */
    async forDocument(id: number): Promise<HealthRecordBundle[]> {
        const { parties, document } = await this.records.standaloneDocument(id);
        return document ? this.build([documentSource(parties, document, `medical-document-${id}`)]) : [];
    }

    /** A lab or imaging report entered at the clinic; a draft is not shared. */
    async forDiagnosticReport(id: number): Promise<HealthRecordBundle[]> {
        const { row: r, parties, document } = await this.records.diagnosticReport(id);
        if (r.Status !== "Final") return [];
        let results: ReportResult[] = [];
        try {
            results = r.Results ? JSON.parse(r.Results) : [];
        } catch { /* unreadable results: the report goes without them, and the builder says if that is not enough */ }
        return this.build([{
            hiType: "DiagnosticReport",
            source: {
                ...parties,
                kind: r.Category === "Imaging" ? "imaging" : "lab",
                entered: {
                    id: String(r.Id),
                    test: { text: r.TestName, conceptId: r.TestConceptId ?? null },
                    issuedAt: new Date(r.IssuedAt),
                    collectedAt: r.CollectedAt ? new Date(r.CollectedAt) : null,
                    performedBy: r.PerformedBy ?? null,
                    specimen: r.SpecimenType ? { text: r.SpecimenType, conceptId: r.SpecimenConceptId ?? null } : null,
                    results: results.map((x, i) => ({
                        id: String(i), name: { text: x.name, conceptId: x.conceptId ?? null },
                        value: x.value ?? null, valueText: x.valueText ?? null, unit: x.unit ?? null,
                        low: x.low ?? null, high: x.high ?? null, referenceText: x.referenceText ?? null, interpretation: x.interpretation ?? null,
                    })),
                    conclusion: r.Conclusion ?? null,
                    conclusionCodes: parseList(r.ConclusionCodes),
                },
                document,
            },
        }]);
    }

    /** A wellness check recorded at the clinic: its measurements, BMI worked out from height and weight. */
    async forWellnessRecord(id: number): Promise<HealthRecordBundle[]> {
        const { row: w, parties } = await this.records.wellnessRecord(id);
        const at = new Date(w.RecordedAt);
        const measurements: WellnessMeasurement[] = [];
        if (w.Systolic != null && w.Diastolic != null) measurements.push({ kind: "bloodPressure", systolic: Number(w.Systolic), diastolic: Number(w.Diastolic), at });
        const add = (kind: Exclude<WellnessMeasurement["kind"], "bloodPressure">, value: unknown) => {
            const n = value === null || value === undefined ? NaN : Number(value);
            if (Number.isFinite(n)) measurements.push({ kind, value: n, at });
        };
        add("heartRate", w.HeartRate);
        add("respiratoryRate", w.RespiratoryRate);
        add("oxygenSaturation", w.SpO2);
        add("temperature", w.TemperatureC);
        add("height", w.HeightCm);
        add("weight", w.WeightKg);
        add("bmi", bmiOf(w.HeightCm, w.WeightKg));
        add("steps", w.Steps);
        add("caloriesBurned", w.CaloriesBurned);
        add("sleepHours", w.SleepHours);
        add("bloodGlucose", w.BloodGlucose);
        add("fluidIntakeLitres", w.FluidIntakeLitres);
        if (!measurements.length) return [];
        return this.build([{ hiType: "WellnessRecord", source: { ...parties, key: `wellness-record-${w.Id}`, date: at, measurements, notes: w.Notes ?? null } }]);
    }

    private build(sources: SourceOf[], hiTypes?: HiType[]): HealthRecordBundle[] {
        const out: HealthRecordBundle[] = [];
        for (const s of sources) {
            if (hiTypes && !hiTypes.includes(s.hiType)) continue;
            try {
                const bundle = (BUILDERS[s.hiType] as (source: unknown, now: Date) => FhirBundle)(s.source, this.now());
                out.push({ hiType: s.hiType, key: bundle.id, bundle });
            } catch (error) {
                if (!(error instanceof FhirSourceError)) throw error;
                console.warn(`[ABDM] ${s.hiType} not built: ${error.message}`);
            }
        }
        return out;
    }
}

export const abdmHealthRecordService = new AbdmHealthRecordService();
