import { IsNull, Like, Not } from "typeorm/index.js";
import { AppDataSource } from "../../config/database.js";
import { Appointment } from "../../models/Appointments/appointment.model.js";
import { PatientMedicalRecord } from "../../models/Appointments/patient-medical-record.model.js";
import { PatientPrescription } from "../../models/Appointments/patient-prescription.model.js";
import { ClinicalNote } from "../../models/Appointments/clinical-note.model.js";
import { MedicalDocument } from "../../models/Appointments/medical-document.model.js";
import { PostVisitDocument } from "../../models/Appointments/post-visit-document.model.js";
import { PatientImmunization } from "../../models/Appointments/patient-immunization.model.js";
import { DischargeSummary } from "../../models/Appointments/discharge-summary.model.js";
import { AppointmentBill } from "../../models/Payments/appointment-bill.model.js";
import { User } from "../../models/Account/user.model.js";
import { Hospital } from "../../models/Organizations/hospital.model.js";
import { HealthcareProvider } from "../../models/Organizations/healthcare-provider.model.js";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import { blobService } from "../../services/Common/blob.service.js";
import { abdmFacilities } from "../../services/Abdm/abdm-facilities.service.js";
import type {
    CodedText, DocumentSource, MedicationSource, OrganizationSource, PatientSource, PractitionerSource, RecordParties,
} from "../../services/Abdm/fhir/fhir-sources.js";

/**
 * Reads ClinicX's records for ABDM: everything recorded at one visit, a discharge summary, or a
 * standalone immunization, mapped to the builders' sources. Reads only.
 */

export interface DocumentReader {
    read(url: string): Promise<Buffer>;
}

export interface VisitRecords {
    parties: RecordParties;
    appointment: { id: number; start: Date; end: Date | null; teleconsultation: boolean };
    registration: { allergies: string | null; medicalHistory: string | null };
    medicalRecords: PatientMedicalRecord[];
    prescriptions: Array<{ row: PatientPrescription; medications: MedicationSource[]; diagnoses: CodedText[]; pdf: Buffer | null }>;
    notes: string[];
    documents: Array<DocumentSource & { category: string }>;
    bills: AppointmentBill[];
    immunizations: PatientImmunization[];
    certificates: Map<number, DocumentSource>;
}

const fullName = (u: Pick<User, "FirstName" | "LastName"> | null | undefined, fallback: string): string =>
    [u?.FirstName, u?.LastName].map((p) => p?.trim()).filter(Boolean).join(" ") || fallback;

/** AppointmentDate plus StartTime ("HH:mm[:ss]"), in the server's time zone. */
export const visitStart = (date: Date | string, time?: string | null): Date => {
    const d = new Date(date);
    const [h, m, s] = (time ?? "00:00").split(":").map((x) => Number(x) || 0);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h ?? 0, m ?? 0, s ?? 0);
};

/** Octet-stream uploads of a .pdf are PDFs; ABDM receivers open attachments by content type. */
export const documentContentType = (mime: string | null | undefined, extension: string | null | undefined): string => {
    const ext = (extension ?? "").replace(/^\./, "").toLowerCase();
    if ((!mime || mime === "application/octet-stream") && ext === "pdf") return "application/pdf";
    if ((!mime || mime === "application/octet-stream") && (ext === "jpg" || ext === "jpeg")) return "image/jpeg";
    if ((!mime || mime === "application/octet-stream") && ext === "png") return "image/png";
    return mime || "application/octet-stream";
};

const coded = (text?: string | null, conceptId?: string | null): CodedText[] =>
    text?.trim() ? [{ text: text.trim(), conceptId: conceptId?.trim() || null }] : [];

/** Medical record rows that are a vitals check rather than a consultation. */
export const isVitalsRecord = (r: Pick<PatientMedicalRecord, "Type">): boolean => /vital/i.test(r.Type ?? "");

/** A consultation record with something written in it, or measured: worth sharing on its own. */
export const hasConsultationContent = (r: Partial<PatientMedicalRecord>): boolean =>
    [r.ChiefComplaint, r.Symptoms, r.PhysicalExamination, r.Diagnosis, r.Treatment, r.BloodPressure, r.HeartRate, r.Temperature, r.Weight, r.Height, r.SpO2]
        .some((v) => typeof v === "string" && v.trim() !== "") || Boolean(r.FollowUpDate);

export class AbdmHealthRecordRepository {
    constructor(private readonly documents: DocumentReader = { read: (url) => blobService.downloadFile(url) }) {}

    async parties(patientId: string, doctorId: string | null | undefined, hospitalId: number): Promise<RecordParties> {
        const [patient, doctor, hospital, provider] = await Promise.all([
            AppDataSource.getRepository(User).findOne({ where: { Id: patientId } }),
            doctorId ? AppDataSource.getRepository(User).findOne({ where: { Id: doctorId } }) : Promise.resolve(null),
            AppDataSource.getRepository(Hospital).findOne({ where: { Id: hospitalId } }),
            doctorId ? AppDataSource.getRepository(HealthcareProvider).findOne({ where: { UserId: doctorId, IsDeleted: false } }) : Promise.resolve(null),
        ]);
        if (!patient) throw new Error(`Patient ${patientId} not found.`);
        if (!hospital) throw new Error(`Hospital ${hospitalId} not found.`);

        const patientSource: PatientSource = {
            id: patient.Id,
            name: fullName(patient, "Patient"),
            gender: patient.Gender ?? null,
            birthDate: patient.DateOfBirth ?? null,
            phone: (patient as any).PhoneNumber ?? null,
            abhaNumber: patient.AbhaNumber ?? null,
            abhaAddress: patient.AbhaAddress ?? null,
        };
        const practitioner: PractitionerSource = doctor
            ? { id: doctor.Id, name: fullName(doctor, "Doctor"), registrationNumber: provider?.RegistrationNumber || null, qualification: provider?.Qualification || null }
            // A record nobody signed is still authored by the facility's staff: named for the hospital.
            : { id: `hospital-${hospital.Id}`, name: `${hospital.Name} staff` };
        const organization: OrganizationSource = {
            id: hospital.Id,
            name: hospital.Name,
            hfrId: (await abdmFacilities.byHospital(hospital.Id))?.hipId ?? null,
            phone: hospital.MobileNumber ?? null,
            email: hospital.Email ?? null,
        };
        return { patient: patientSource, practitioner, organization };
    }

    /**
     * Everything recorded at one visit. With files: false the documents are listed but not
     * downloaded (their data is empty): enough to say which HI types the visit holds.
     */
    async visit(appointmentId: number, options: { files: boolean } = { files: true }): Promise<VisitRecords> {
        const appointment = await AppDataSource.getRepository(Appointment).findOne({ where: { Id: appointmentId } });
        if (!appointment) throw new Error(`Appointment ${appointmentId} not found.`);
        const { UserId: patientId, HospitalId: hospitalId } = appointment;

        const [parties, registration, medicalRecords, prescriptionRows, notes, documentRows, bills, immunizations, postVisitRows] = await Promise.all([
            this.parties(patientId, appointment.DoctorId, hospitalId),
            AppDataSource.getRepository(PatientRegistration).findOne({ where: { UserId: patientId, HospitalId: hospitalId, IsDeleted: false } }),
            AppDataSource.getRepository(PatientMedicalRecord).find({ where: { AppointmentId: appointmentId }, order: { Date: "ASC" } }),
            // PatientPrescription.AppointmentId is stored as text
            AppDataSource.getRepository(PatientPrescription).find({
                where: { AppointmentId: String(appointmentId) },
                relations: { Medications: true, Diagnoses: true },
                order: { CreatedAt: "ASC" },
            }),
            AppDataSource.getRepository(ClinicalNote).find({ where: { AppointmentId: appointmentId }, order: { CreatedAt: "ASC" } }),
            AppDataSource.getRepository(MedicalDocument).find({ where: { AppointmentId: appointmentId, IsDeleted: false }, order: { CreatedAt: "ASC" } }),
            AppDataSource.getRepository(AppointmentBill).find({
                where: { AppointmentId: appointmentId, IsDeleted: false, BillStatus: Not("Draft") },
                relations: { BillItems: true },
                order: { CreatedAt: "ASC" },
            }),
            AppDataSource.getRepository(PatientImmunization).find({ where: { AppointmentId: appointmentId, IsDeleted: false }, order: { AdministeredOn: "ASC" } }),
            // Files produced after the visit (reports, summaries). Its prescription PDF is left out: the
            // Prescription bundle already carries the clinic's signed copy.
            AppDataSource.getRepository(PostVisitDocument).find({
                where: { AppointmentId: appointmentId, IsDeleted: false, Status: "ACTIVE", DocumentType: Not("PRESCRIPTION") },
                order: { CreatedAt: "ASC" },
            }),
        ]);

        const prescriptions = await Promise.all(prescriptionRows.map(async (row) => ({
            row,
            medications: (row.Medications ?? []).map((m) => this.medication(m)),
            diagnoses: (row.Diagnoses ?? []).flatMap((d) => coded(d.Diagnosis, d.DiagnosisConceptId)),
            pdf: options.files && row.PdfUrl && /^https:\/\/[^/]+\.blob\.core\.windows\.net\//.test(row.PdfUrl) ? await this.tryRead(row.PdfUrl) : null,
        })));

        const documents = (await Promise.all(documentRows.map(async (d) => {
            const data = options.files ? await this.tryRead(d.BlobUrl) : Buffer.alloc(0);
            return data ? {
                id: `medical-document-${d.Id}`,
                title: d.Description?.trim() || d.OriginalFileName || d.FileName,
                category: d.DocumentCategory,
                contentType: documentContentType(d.MimeType, d.FileExtension),
                data,
                createdAt: d.CreatedAt,
            } : null;
        }))).filter((d): d is NonNullable<typeof d> => d !== null);
        const postVisitDocuments = (await Promise.all(postVisitRows.map(async (d) => {
            const data = options.files ? await this.tryRead(d.BlobUrl) : Buffer.alloc(0);
            return data ? {
                id: `post-visit-document-${d.Id}`,
                title: d.FileName,
                category: d.DocumentType,
                contentType: documentContentType(d.MimeType, d.FileName?.split(".").pop()),
                data,
                createdAt: d.GeneratedAt ?? d.CreatedAt,
            } : null;
        }))).filter((d): d is NonNullable<typeof d> => d !== null);

        return {
            parties,
            appointment: {
                id: appointment.Id,
                start: visitStart(appointment.AppointmentDate, appointment.StartTime),
                end: appointment.EndTime ? visitStart(appointment.AppointmentDate, appointment.EndTime) : null,
                teleconsultation: Boolean(appointment.IsTeleConsultation),
            },
            registration: { allergies: registration?.Allergies?.trim() || null, medicalHistory: registration?.MedicalHistory?.trim() || null },
            medicalRecords,
            prescriptions,
            notes: notes.map((n) => n.Notes ?? "").filter((n) => n.trim()),
            documents: [...documents, ...postVisitDocuments],
            bills,
            immunizations,
            certificates: options.files ? await this.certificates(immunizations) : new Map(),
        };
    }

    async dischargeSummary(id: number) {
        const summary = await AppDataSource.getRepository(DischargeSummary).findOne({ where: { Id: id, IsDeleted: false } });
        if (!summary) throw new Error(`Discharge summary ${id} not found.`);
        const [parties, prescription, document] = await Promise.all([
            this.parties(summary.PatientId, summary.DoctorId, summary.HospitalId),
            summary.PrescriptionId
                ? AppDataSource.getRepository(PatientPrescription).findOne({ where: { Id: summary.PrescriptionId }, relations: { Medications: true } })
                : Promise.resolve(null),
            summary.DocumentId ? this.document(summary.DocumentId) : Promise.resolve(null),
        ]);
        return { summary, parties, medications: (prescription?.Medications ?? []).map((m) => this.medication(m)), document };
    }

    async immunization(id: number) {
        const row = await AppDataSource.getRepository(PatientImmunization).findOne({ where: { Id: id, IsDeleted: false } });
        if (!row) throw new Error(`Immunization ${id} not found.`);
        return { row, parties: await this.parties(row.PatientId, row.DoctorId, row.HospitalId), certificates: await this.certificates([row]) };
    }

    /** A vitals check outside a visit (stored with AppointmentId 0 or none). */
    async vitalsRecord(id: string) {
        const row = await AppDataSource.getRepository(PatientMedicalRecord).findOne({ where: { Id: id } });
        if (!row) throw new Error(`Vitals record ${id} not found.`);
        if (!row.HospitalId) throw new Error(`Vitals record ${id} names no hospital, so no facility can share it.`);
        return { row, parties: await this.parties(row.PatientId, row.DoctorId, row.HospitalId) };
    }

    /**
     * Records outside a visit, each a care context of its own: Final discharge summaries,
     * immunizations given outside a visit, and vitals checks (AppointmentId 0 or none).
     */
    async standaloneRecordIds(patientId: string, hospitalId: number) {
        const noVisit = [IsNull(), 0] as const;
        const [summaries, immunizations, vitals] = await Promise.all([
            AppDataSource.getRepository(DischargeSummary).find({ where: { PatientId: patientId, HospitalId: hospitalId, Status: "Final", IsDeleted: false }, select: { Id: true } }),
            AppDataSource.getRepository(PatientImmunization).find({ where: { PatientId: patientId, HospitalId: hospitalId, AppointmentId: IsNull(), IsDeleted: false }, select: { Id: true } }),
            AppDataSource.getRepository(PatientMedicalRecord).find({
                where: noVisit.map((AppointmentId) => ({ PatientId: patientId, HospitalId: hospitalId, AppointmentId, Type: Like("%ital%") })),
                select: { Id: true },
            }),
        ]);
        return {
            dischargeSummaryIds: summaries.map((s) => s.Id),
            immunizationIds: immunizations.map((i) => i.Id),
            vitalsRecordIds: vitals.map((v) => v.Id),
        };
    }

    /**
     * The rest of a patient's records saved outside a visit at this hospital, each a care context
     * of its own: prescriptions with medicines, consultation records and clinical notes with
     * something written, and documents the clinic uploaded that are shareable and not
     * confidential (one attached to a discharge summary or an immunization travels with that).
     */
    async standaloneRecords(patientId: string, hospitalId: number) {
        const q = (sql: string) => AppDataSource.query(sql, [patientId, hospitalId]);
        const noVisit = (column: string) => `(${column} IS NULL OR CAST(${column} AS VARCHAR(40)) IN ('', '0'))`;
        const [prescriptions, records, notes, documents] = await Promise.all([
            q(`SELECT p.Id, COALESCE(p.Date, p.CreatedAt) AS RecordDate FROM PatientPrescription p
               WHERE p.PatientId = @0 AND p.HospitalId = @1 AND ${noVisit("p.AppointmentId")}
                 AND EXISTS (SELECT 1 FROM PrescriptionMedication m WHERE m.PrescriptionId = p.Id)`),
            AppDataSource.getRepository(PatientMedicalRecord).find({
                where: [IsNull(), 0].map((AppointmentId) => ({ PatientId: patientId, HospitalId: hospitalId, AppointmentId })),
            }),
            q(`SELECT Id, CreatedAt FROM PatientClinicalNotes
               WHERE PatientId = @0 AND HospitalId = @1 AND ${noVisit("AppointmentId")} AND LEN(LTRIM(RTRIM(COALESCE(Notes, '')))) > 0`),
            q(`SELECT d.Id, d.CreatedAt, d.DocumentCategory FROM MedicalDocuments d
               WHERE d.PatientId = @0 AND d.HospitalId = @1 AND ${noVisit("d.AppointmentId")} AND d.IsDeleted = 0
                 AND d.IsShareable = 1 AND d.IsConfidential = 0 AND d.IsPatientUploaded = 0
                 AND COALESCE(d.DocumentCategory, '') NOT LIKE '%insurance%'
                 AND NOT EXISTS (SELECT 1 FROM DischargeSummaries s WHERE s.DocumentId = d.Id AND s.IsDeleted = 0)
                 AND NOT EXISTS (SELECT 1 FROM PatientImmunizations i WHERE i.CertificateDocumentId = d.Id AND i.IsDeleted = 0)`),
        ]);
        return {
            prescriptions: prescriptions.map((r: any) => ({ id: String(r.Id), date: new Date(r.RecordDate) })),
            consultations: records.filter((r) => !isVitalsRecord(r) && hasConsultationContent(r)).map((r) => ({ id: r.Id, date: new Date(r.Date) })),
            notes: notes.map((r: any) => ({ id: Number(r.Id), date: new Date(r.CreatedAt) })),
            documents: documents.map((r: any) => ({ id: Number(r.Id), date: new Date(r.CreatedAt), category: r.DocumentCategory ?? null })),
        };
    }

    /** A prescription saved outside a visit, with its medicines, diagnoses and the clinic's PDF. */
    async prescription(id: string) {
        const row = await AppDataSource.getRepository(PatientPrescription).findOne({ where: { Id: id }, relations: { Medications: true, Diagnoses: true } });
        if (!row) throw new Error(`Prescription ${id} not found.`);
        if (!row.HospitalId) throw new Error(`Prescription ${id} names no hospital, so no facility can share it.`);
        const [parties, pdf] = await Promise.all([
            this.parties(row.PatientId, row.DoctorId, row.HospitalId),
            row.PdfUrl && /^https:\/\/[^/]+\.blob\.core\.windows\.net\//.test(row.PdfUrl) ? this.tryRead(row.PdfUrl) : Promise.resolve(null),
        ]);
        return {
            row, parties, pdf,
            medications: (row.Medications ?? []).map((m) => this.medication(m)),
            diagnoses: (row.Diagnoses ?? []).flatMap((d) => coded(d.Diagnosis, d.DiagnosisConceptId)),
        };
    }

    /** A consultation record (a PatientMedicalRecord that is not a vitals check) saved outside a visit. */
    async consultationRecord(id: string) {
        const row = await AppDataSource.getRepository(PatientMedicalRecord).findOne({ where: { Id: id } });
        if (!row) throw new Error(`Medical record ${id} not found.`);
        if (!row.HospitalId) throw new Error(`Medical record ${id} names no hospital, so no facility can share it.`);
        return { row, parties: await this.parties(row.PatientId, row.DoctorId, row.HospitalId) };
    }

    /** A clinical note saved outside a visit. */
    async clinicalNote(id: number) {
        const row = await AppDataSource.getRepository(ClinicalNote).findOne({ where: { Id: id } });
        if (!row) throw new Error(`Clinical note ${id} not found.`);
        if (!row.HospitalId) throw new Error(`Clinical note ${id} names no hospital, so no facility can share it.`);
        return { row, parties: await this.parties(row.PatientId, row.DoctorId, Number(row.HospitalId)) };
    }

    /** A document the clinic uploaded outside a visit, with its file. */
    async standaloneDocument(id: number) {
        const row = await AppDataSource.getRepository(MedicalDocument).findOne({ where: { Id: id, IsDeleted: false } });
        if (!row) throw new Error(`Document ${id} not found.`);
        const [parties, document] = await Promise.all([this.parties(row.PatientId, row.DoctorId, Number(row.HospitalId)), this.document(id)]);
        return { parties, document };
    }

    private medication(m: { Id: string; Medication: string; ConceptId?: string; Dosage?: string; DurationValue?: number; DurationUnit?: string; FrequencyType?: string; Route?: string; Instructions?: string }): MedicationSource {
        return {
            id: `prescription-medication-${m.Id}`,
            name: m.Medication,
            conceptId: m.ConceptId?.trim() || null,
            dosage: m.Dosage ?? null,
            frequency: m.FrequencyType ?? null,
            // Older rows keep the whole duration ("7 days") in DurationUnit, with no DurationValue
            duration: [m.DurationValue, m.DurationUnit].filter((x) => x !== null && x !== undefined && String(x).trim()).join(" ") || null,
            route: m.Route ?? null,
            instructions: m.Instructions ?? null,
        };
    }

    private async certificates(rows: PatientImmunization[]): Promise<Map<number, DocumentSource>> {
        const ids = rows.map((r) => r.CertificateDocumentId).filter((x): x is number => Boolean(x));
        const out = new Map<number, DocumentSource>();
        if (!ids.length) return out;
        for (const id of new Set(ids)) {
            const doc = await this.document(id);
            if (doc) out.set(id, doc);
        }
        return out;
    }

    private async document(id: number): Promise<DocumentSource | null> {
        const d = await AppDataSource.getRepository(MedicalDocument).findOne({ where: { Id: id, IsDeleted: false } });
        if (!d) return null;
        const data = await this.tryRead(d.BlobUrl);
        return data ? {
            id: `medical-document-${d.Id}`,
            title: d.Description?.trim() || d.OriginalFileName || d.FileName,
            category: d.DocumentCategory,
            contentType: documentContentType(d.MimeType, d.FileExtension),
            data,
            createdAt: d.CreatedAt,
        } : null;
    }

    /** A file that can't be read is left out of the record and named in the log, never sent empty. */
    private async tryRead(url: string): Promise<Buffer | null> {
        try {
            const data = await this.documents.read(url);
            return data.length ? data : null;
        } catch (error: any) {
            console.warn(`[ABDM] a document could not be read for a health record: ${error?.message}`);
            return null;
        }
    }
}

export const abdmHealthRecordRepository = new AbdmHealthRecordRepository();
