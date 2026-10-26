import { FhirSourceError, type FhirBundle, type HiType } from "./fhir/fhir-common.js";
import { BUILDERS, type RecordSourceFor } from "./fhir/health-records.js";
import type { CodedText, DiagnosticKind, VisitVitals, WellnessMeasurement } from "./fhir/fhir-sources.js";
import { visitVitalsToMeasurements } from "./fhir/measurements.js";
import { abdmHealthRecordRepository, type AbdmHealthRecordRepository, type VisitRecords } from "../../repositories/Abdm/abdm-health-record.repository.js";
import type { PatientMedicalRecord } from "../../models/Appointments/patient-medical-record.model.js";

/**
 * Which ABDM health records a care context holds, built as NRCES bundles. A visit (an appointment)
 * can hold all eight HI types; a discharge summary and an immunization given outside a visit are
 * care contexts of their own. A type with nothing recorded is not offered, never sent empty.
 */

export interface HealthRecordBundle {
    hiType: HiType;
    /** Stable within the care context: the record's own id. */
    key: string;
    bundle: FhirBundle;
}

type SourceOf = { [T in HiType]: { hiType: T; source: RecordSourceFor[T] } }[HiType];

/** Medical record rows that are a vitals check rather than a consultation. */
export const isVitalsRecord = (r: Pick<PatientMedicalRecord, "Type">): boolean => /vital/i.test(r.Type ?? "");

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
const coded = (text?: string | null, conceptId?: string | null): CodedText[] =>
    text?.trim() ? [{ text: text.trim(), conceptId: conceptId?.trim() || null }] : [];

/** The records one visit holds, as builder sources. Pure: everything it needs is in [v]. */
export const visitSources = (v: VisitRecords): SourceOf[] => {
    const out: SourceOf[] = [];
    const visitKey = `appointment-${v.appointment.id}`;
    const consultations = v.medicalRecords.filter((r) => !isVitalsRecord(r));
    const vitalsChecks = v.medicalRecords.filter(isVitalsRecord);

    if (consultations.length || v.notes.length || v.prescriptions.length) {
        const withVitals = consultations.find((r) => r.BloodPressure || r.HeartRate || r.Temperature || r.Weight || r.Height || r.SpO2);
        const followUps = consultations.map((r) => r.FollowUpDate).filter((d): d is Date => Boolean(d));
        out.push({
            hiType: "OPConsultation",
            source: {
                ...v.parties,
                visit: { id: v.appointment.id, start: v.appointment.start, end: v.appointment.end, teleconsultation: v.appointment.teleconsultation },
                chiefComplaints: consultations.flatMap((r) => [...coded(r.ChiefComplaint, r.ChiefComplaintConceptId), ...coded(r.Symptoms, r.SymptomConceptId)]),
                examinationFindings: consultations.flatMap((r) => coded(r.PhysicalExamination, r.PhysicalExaminationConceptId)),
                vitals: withVitals ? vitalsOf(withVitals) : null,
                vitalsRecordedAt: withVitals?.Date ?? null,
                allergies: v.registration.allergies,
                medicalHistory: v.registration.medicalHistory,
                diagnoses: consultations.flatMap((r) => coded(r.Diagnosis, r.DiagnosisConceptId)),
                procedures: consultations.flatMap((r) => coded(r.Treatment, r.TreatmentConceptId)),
                medications: v.prescriptions.flatMap((p) => p.medications),
                authoredOn: v.prescriptions[0]?.row.Date ?? null,
                notes: v.notes,
                followUp: followUps.length ? new Date(Math.max(...followUps.map((d) => new Date(d).getTime()))) : null,
                documents: [],
            },
        });
    }

    for (const p of v.prescriptions) {
        if (!p.medications.length) continue;
        out.push({
            hiType: "Prescription",
            source: {
                ...v.parties,
                prescription: {
                    id: p.row.Id,
                    number: p.row.PrescriptionNumber ?? null,
                    date: p.row.Date ?? p.row.CreatedAt ?? v.appointment.start,
                    notes: p.row.Notes ?? null,
                    diagnoses: p.diagnoses,
                    medications: p.medications,
                    signedCopy: p.pdf ? { contentType: "application/pdf", data: p.pdf } : null,
                },
            },
        });
    }

    const healthDocuments = [];
    for (const d of v.documents) {
        const kind = diagnosticKind(d.category);
        if (kind) out.push({ hiType: "DiagnosticReport", source: { ...v.parties, kind, report: d } });
        else healthDocuments.push(d);
    }
    if (healthDocuments.length) {
        out.push({
            hiType: "HealthDocumentRecord",
            source: { ...v.parties, key: `${visitKey}:documents`, date: v.appointment.start, title: "Health documents", documents: healthDocuments },
        });
    }

    const measurements: WellnessMeasurement[] = vitalsChecks.flatMap((r) => visitVitalsToMeasurements(vitalsOf(r), new Date(r.Date)));
    if (measurements.length) {
        out.push({ hiType: "WellnessRecord", source: { ...v.parties, key: `${visitKey}:wellness`, date: v.appointment.start, measurements } });
    }

    for (const b of v.bills) {
        out.push({
            hiType: "Invoice",
            source: {
                ...v.parties,
                bill: {
                    id: b.AppointmentBillId,
                    number: b.BillNumber,
                    date: b.CreatedAt,
                    status: b.BillStatus,
                    subTotal: Number(b.SubTotal), discount: Number(b.DiscountAmount), total: Number(b.TotalAmount),
                    cgst: Number(b.CgstAmount), sgst: Number(b.SgstAmount), igst: Number(b.IgstAmount),
                    items: (b.BillItems ?? []).map((i) => ({
                        id: i.AppointmentBillItemId, type: i.ItemType, name: i.ItemName, quantity: Number(i.Quantity),
                        unitPrice: Number(i.UnitPrice), discount: Number(i.DiscountAmount), gstAmount: Number(i.GstAmount), total: Number(i.TotalAmount),
                    })),
                },
            },
        });
    }

    if (v.immunizations.length) {
        const certificate = v.immunizations.map((i) => i.CertificateDocumentId && v.certificates.get(i.CertificateDocumentId)).find(Boolean) || null;
        out.push({
            hiType: "ImmunizationRecord",
            source: {
                ...v.parties,
                key: `${visitKey}:immunizations`,
                date: v.appointment.start,
                immunizations: v.immunizations.map((i) => ({
                    id: `patient-immunization-${i.Id}`,
                    vaccine: { text: i.VaccineName, conceptId: i.VaccineConceptId },
                    date: i.AdministeredOn,
                    doseNumber: i.DoseNumber, lotNumber: i.LotNumber, manufacturer: i.Manufacturer, route: i.Route, site: i.Site,
                    nextDueDate: i.NextDueDate, notes: i.Notes,
                })),
                certificate,
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
        private readonly records: Pick<AbdmHealthRecordRepository, "visit" | "dischargeSummary" | "immunization" | "vitalsRecord"> = abdmHealthRecordRepository,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async forAppointment(appointmentId: number, hiTypes?: HiType[]): Promise<HealthRecordBundle[]> {
        return this.build(visitSources(await this.records.visit(appointmentId)), hiTypes);
    }

    /** A Final discharge summary; a draft is not shared. */
    async forDischargeSummary(id: number): Promise<HealthRecordBundle[]> {
        const { summary: s, parties, medications, document } = await this.records.dischargeSummary(id);
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
                date: new Date(i.AdministeredOn),
                immunizations: [{
                    id: `patient-immunization-${i.Id}`,
                    vaccine: { text: i.VaccineName, conceptId: i.VaccineConceptId },
                    date: i.AdministeredOn,
                    doseNumber: i.DoseNumber, lotNumber: i.LotNumber, manufacturer: i.Manufacturer, route: i.Route, site: i.Site,
                    nextDueDate: i.NextDueDate, notes: i.Notes,
                }],
                certificate: (i.CertificateDocumentId && certificates.get(i.CertificateDocumentId)) || null,
            },
        }]);
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
