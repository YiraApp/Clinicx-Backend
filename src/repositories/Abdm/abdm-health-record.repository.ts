import { In, IsNull, Like, Not } from "typeorm/index.js";
import { AppDataSource } from "../../config/database.js";
import { Appointment } from "../../models/Appointments/appointment.model.js";
import { PatientMedicalRecord } from "../../models/Appointments/patient-medical-record.model.js";
import { PatientPrescription } from "../../models/Appointments/patient-prescription.model.js";
import { ClinicalNote } from "../../models/Appointments/clinical-note.model.js";
import { MedicalDocument } from "../../models/Appointments/medical-document.model.js";
import { PostVisitDocument } from "../../models/Appointments/post-visit-document.model.js";
import { PatientDiagnosticReport } from "../../models/Appointments/diagnostic-report.model.js";
import { WellnessRecord } from "../../models/Appointments/wellness-record.model.js";
import { PatientImmunization } from "../../models/Appointments/patient-immunization.model.js";
import { DischargeSummary } from "../../models/Appointments/discharge-summary.model.js";
import { AppointmentBill } from "../../models/Payments/appointment-bill.model.js";
import { User } from "../../models/Account/user.model.js";
import { Hospital } from "../../models/Organizations/hospital.model.js";
import { HealthcareProvider } from "../../models/Organizations/healthcare-provider.model.js";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import { blobService } from "../../services/Common/blob.service.js";
import { abdmFacilities } from "../../services/Abdm/abdm-facilities.service.js";
import { codedText } from "../../services/Abdm/fhir/fhir-common.js";
import type {
    CodedText, DocumentSource, MedicationSource, OrganizationSource, PatientSource, PractitionerSource, RecordParties, VisitRef,
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
    /** practitioner: the prescriber, when a registered doctor of the hospital other than the visit's. */
    prescriptions: Array<{ row: PatientPrescription; medications: MedicationSource[]; diagnoses: CodedText[]; pdf: Buffer | null; practitioner?: PractitionerSource | null }>;
    /** The visit's clinical notes, each with when it was written. */
    notes: Array<{ text: string; at: Date }>;
    documents: Array<DocumentSource & { category: string }>;
    bills: AppointmentBill[];
    immunizations: PatientImmunization[];
    certificates: Map<number, DocumentSource>;
    /** The doctors recorded as giving the visit's vaccines, by DoctorId in lower case. */
    givenBy?: Map<string, PractitionerSource>;
}

const fullName = (u: Pick<User, "FirstName" | "LastName"> | null | undefined, fallback: string): string =>
    [u?.FirstName, u?.LastName].map((p) => p?.trim()).filter(Boolean).join(" ") || fallback;

/** AppointmentDate plus StartTime ("HH:mm[:ss]"), in the server's time zone. */
export const visitStart = (date: Date | string, time?: string | null): Date => {
    const d = new Date(date);
    const [h, m, s] = (time ?? "00:00").split(":").map((x) => Number(x) || 0);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h ?? 0, m ?? 0, s ?? 0);
};

// The kinds of file the front desk sends after a visit, in words
const POST_VISIT_KINDS: Record<string, string> = { CLINICAL_NOTES: "Clinical notes", MEDICAL_RECORD: "Medical record", SUMMARY: "Visit summary" };

/** Octet-stream uploads of a .pdf are PDFs; ABDM receivers open attachments by content type. */
export const documentContentType = (mime: string | null | undefined, extension: string | null | undefined): string => {
    const ext = (extension ?? "").replace(/^\./, "").toLowerCase();
    if ((!mime || mime === "application/octet-stream") && ext === "pdf") return "application/pdf";
    if ((!mime || mime === "application/octet-stream") && (ext === "jpg" || ext === "jpeg")) return "image/jpeg";
    if ((!mime || mime === "application/octet-stream") && ext === "png") return "image/png";
    return mime || "application/octet-stream";
};

/**
 * Azure SQL keeps UTC, so a datetime the database stamped itself (a GETDATE() default) holds the UTC
 * clock, and the driver reads every datetime as this process's clock (IST): such a value comes back
 * 5h30 early. This gives back the instant it was stamped. A time the app wrote from JS is IST already
 * and must not go through it.
 */
export const fromDbClock = (d: Date): Date =>
    new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()));

/** Whether [value] was stamped by the database together with its row's CreatedAt (a default), rather than written by the app. */
export const stampedWithRow = (value: Date | string, createdAt: Date | string | null | undefined): boolean =>
    createdAt != null && Math.abs(new Date(value).getTime() - new Date(createdAt).getTime()) < 2 * 60_000;

/** A row's time, read right: a database stamp is corrected, a time the app wrote is kept. */
const rowTime = (value: Date | string, dbStamped: boolean): Date => (dbStamped ? fromDbClock(new Date(value)) : new Date(value));

// Who writes these times from JS rather than leaving them to the database's default
const PULSE_DOCUMENT = "PulseWhatsApp";
const PULSE_NOTE = "Pulse AI Parser";

/** A prescription's date: the database's default, never written by the app. */
const prescriptionDate = (row: Pick<PatientPrescription, "Date" | "CreatedAt">): Date | undefined =>
    row.Date ? fromDbClock(new Date(row.Date)) : row.CreatedAt ?? undefined;

/** A medical record's Date: the database's default, except a vitals check the mobile app stamps itself. */
const medicalRecordDate = (row: Pick<PatientMedicalRecord, "Date" | "CreatedAt">): Date => rowTime(row.Date, stampedWithRow(row.Date, row.CreatedAt));

/**
 * A prescription PDF the clinic generated, for a prescription shared as a Prescription record (one
 * with medicines): its archive copy (named Prescription_<id>.pdf), or an upload whose file was
 * overwritten with one. A prescription without medicines has no Prescription record, so its PDF stays.
 */
const isPrescriptionCopy = (d: { FileName?: string | null; BlobUrl?: string | null }, copies: { urls: Set<string>; names: Set<string> }): boolean =>
    copies.urls.has(d.BlobUrl ?? "") || copies.names.has((d.FileName ?? "").toLowerCase());

// The record's visit, when it was made at one of the same patient's appointments at the same hospital
const visitOf = (a: Appointment | null, patientId: string, hospitalId: number): VisitRef | null =>
    a && String(a.UserId).toLowerCase() === String(patientId).toLowerCase() && Number(a.HospitalId) === Number(hospitalId)
        ? { id: a.Id, start: visitStart(a.AppointmentDate, a.StartTime), end: a.EndTime ? visitStart(a.AppointmentDate, a.EndTime) : null, teleconsultation: Boolean(a.IsTeleConsultation) }
        : null;

/** Medical record rows that are a vitals check rather than a consultation. */
export const isVitalsRecord = (r: Pick<PatientMedicalRecord, "Type">): boolean => /vital/i.test(r.Type ?? "");

/** A consultation record with something written in it, or measured: worth sharing on its own. */
export const hasConsultationContent = (r: Partial<PatientMedicalRecord>): boolean =>
    [r.ChiefComplaint, r.Symptoms, r.PhysicalExamination, r.Diagnosis, r.Treatment, r.BloodPressure, r.HeartRate, r.Temperature, r.Weight, r.Height, r.SpO2]
        .some((v) => typeof v === "string" && v.trim() !== "") || Boolean(r.FollowUpDate);

export class AbdmHealthRecordRepository {
    constructor(private readonly documents: DocumentReader = { read: (url) => blobService.downloadFile(url) }) {}

    /** A doctor who is a registered provider at [hospitalId], as a practitioner; null for anyone else. */
    async providerAt(doctorId: string | null | undefined, hospitalId: number): Promise<PractitionerSource | null> {
        if (!doctorId) return null;
        const [doctor, provider] = await Promise.all([
            AppDataSource.getRepository(User).findOne({ where: { Id: doctorId } }),
            AppDataSource.getRepository(HealthcareProvider).findOne({ where: { UserId: doctorId, HospitalId: hospitalId, IsDeleted: false } }),
        ]);
        return doctor && provider
            ? { id: doctor.Id, name: fullName(doctor, "Doctor"), registrationNumber: provider.RegistrationNumber || null, qualification: provider.Qualification || null }
            : null;
    }

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
     * The visit's documents follow the rules a document saved outside a visit does: only what the
     * clinic uploaded, shareable and not confidential, and not an insurance paper. A file that is
     * another record's (a prescription's PDF, a vaccine's certificate, a Final report's or discharge
     * summary's file) travels with that record, and a copy sent to the patient is the upload once.
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
        // Read as the instants they were stamped
        for (const r of medicalRecords) r.Date = medicalRecordDate(r);
        for (const row of prescriptionRows) row.Date = prescriptionDate(row);

        const prescriptions = await Promise.all(prescriptionRows.map(async (row) => ({
            row,
            medications: (row.Medications ?? []).map((m) => this.medication(m, row.Notes)),
            diagnoses: (row.Diagnoses ?? []).flatMap((d) => codedText(d.Diagnosis, d.DiagnosisConceptId)),
            pdf: options.files && row.PdfUrl && /^https:\/\/[^/]+\.blob\.core\.windows\.net\//.test(row.PdfUrl) ? await this.tryRead(row.PdfUrl) : null,
            // Written by another of the hospital's doctors than the visit's: theirs
            practitioner: row.DoctorId && row.DoctorId.toLowerCase() !== String(appointment.DoctorId ?? "").toLowerCase() ? await this.providerAt(row.DoctorId, hospitalId) : null,
        })));

        const ownedByRecords = await this.documentsOfOtherRecords(documentRows.map((d) => Number(d.Id)));
        const prescriptionPdfs = await this.prescriptionPdfs([...documentRows.map((d) => d.BlobUrl), ...postVisitRows.map((d) => d.BlobUrl)], documentRows.map((d) => d.FileName));
        const shared = documentRows.filter((d) => !d.IsPatientUploaded && d.IsShareable !== false && !d.IsConfidential
            && !/insurance/i.test(d.DocumentCategory ?? "") && !isPrescriptionCopy(d, prescriptionPdfs) && !ownedByRecords.has(Number(d.Id)));
        const documents = (await Promise.all(shared.map(async (d) => {
            const data = options.files ? await this.tryRead(d.BlobUrl) : Buffer.alloc(0);
            return data ? {
                id: `medical-document-${d.Id}`,
                title: d.Description?.trim() || d.OriginalFileName || d.FileName,
                category: d.DocumentCategory,
                contentType: documentContentType(d.MimeType, d.FileExtension),
                data,
                createdAt: rowTime(d.CreatedAt, d.CreatedBy !== PULSE_DOCUMENT),
            } : null;
        }))).filter((d): d is NonNullable<typeof d> => d !== null);
        // A copy of an upload (or of a prescription) sent to the patient is not another document; each file once
        const seenFiles = new Set(documentRows.map((d) => d.BlobUrl));
        const ownPostVisitRows = postVisitRows.filter((d) => {
            if (!d.BlobUrl) return true;
            if (seenFiles.has(d.BlobUrl) || prescriptionPdfs.urls.has(d.BlobUrl)) return false;
            seenFiles.add(d.BlobUrl);
            return true;
        });
        const postVisitDocuments = (await Promise.all(ownPostVisitRows.map(async (d) => {
            const data = options.files ? await this.tryRead(d.BlobUrl) : Buffer.alloc(0);
            const at = d.GeneratedAt ?? d.CreatedAt;
            return data ? {
                id: `post-visit-document-${d.Id}`,
                title: d.FileName,
                category: POST_VISIT_KINDS[d.DocumentType] ?? d.DocumentType,
                contentType: documentContentType(d.MimeType, d.FileName?.split(".").pop()),
                data,
                createdAt: rowTime(at, d.CreatedBy !== PULSE_DOCUMENT && stampedWithRow(at, d.CreatedAt)),
            } : null;
        }))).filter((d): d is NonNullable<typeof d> => d !== null);

        const givenBy = new Map<string, PractitionerSource>();
        for (const id of new Set(immunizations.map((i) => i.DoctorId?.toLowerCase()).filter((x): x is string => Boolean(x)))) {
            const p = await this.providerAt(id, hospitalId);
            if (p) givenBy.set(id, p);
        }

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
            notes: notes.filter((n) => n.Notes?.trim()).map((n) => ({ text: n.Notes!, at: rowTime(n.CreatedAt, n.CreatedBy !== PULSE_NOTE) })),
            documents: [...documents, ...postVisitDocuments],
            bills,
            immunizations,
            certificates: options.files ? await this.certificates(immunizations) : new Map(),
            givenBy,
        };
    }

    /** Of these uploads, the ones another record carries: a vaccine's certificate, a Final report's or discharge summary's file. */
    private async documentsOfOtherRecords(ids: number[]): Promise<Set<number>> {
        const list = ids.filter((id) => Number.isFinite(id)).join(",");
        if (!list) return new Set();
        const rows: Array<{ Id: number }> = await AppDataSource.query(`
            SELECT CertificateDocumentId AS Id FROM PatientImmunizations WHERE CertificateDocumentId IN (${list}) AND IsDeleted = 0
            UNION SELECT DocumentId FROM DiagnosticReports WHERE DocumentId IN (${list}) AND IsDeleted = 0 AND Status = 'Final'
            UNION SELECT DocumentId FROM DischargeSummaries WHERE DocumentId IN (${list}) AND IsDeleted = 0 AND Status = 'Final'`);
        return new Set(rows.map((r) => Number(r.Id)));
    }

    /** Which of these files and archive names are the PDF of a prescription with medicines (see isPrescriptionCopy). */
    private async prescriptionPdfs(urls: Array<string | null | undefined>, fileNames: Array<string | null | undefined>): Promise<{ urls: Set<string>; names: Set<string> }> {
        const wantedUrls = [...new Set(urls.filter((u): u is string => Boolean(u)))];
        // Only a uuid can be a prescription's id: "Prescription_Apollo.pdf" is an upload, and the column would refuse it
        const ids = [...new Set(fileNames.map((f) => /^Prescription_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pdf$/i.exec(f ?? "")?.[1]).filter((x): x is string => Boolean(x)))];
        if (!wantedUrls.length && !ids.length) return { urls: new Set(), names: new Set() };
        const rows = await AppDataSource.getRepository(PatientPrescription).find({
            where: [...(wantedUrls.length ? [{ PdfUrl: In(wantedUrls) }] : []), ...(ids.length ? [{ Id: In(ids) }] : [])],
            relations: { Medications: true },
        });
        const prescribed = rows.filter((r) => (r.Medications ?? []).length);
        return {
            urls: new Set(prescribed.map((r) => r.PdfUrl).filter((u): u is string => Boolean(u))),
            names: new Set(prescribed.map((r) => `prescription_${r.Id}.pdf`.toLowerCase())),
        };
    }

    /** When an uploaded document was saved: for a care context already linked whose record no longer makes it. */
    async documentDate(id: number): Promise<Date | null> {
        const d = await AppDataSource.getRepository(MedicalDocument).findOne({ where: { Id: id }, select: { Id: true, CreatedAt: true, CreatedBy: true } });
        return d ? rowTime(d.CreatedAt, d.CreatedBy !== PULSE_DOCUMENT) : null;
    }

    async dischargeSummary(id: number) {
        const summary = await AppDataSource.getRepository(DischargeSummary).findOne({ where: { Id: id, IsDeleted: false } });
        if (!summary) throw new Error(`Discharge summary ${id} not found.`);
        const [parties, prescription, document] = await Promise.all([
            this.parties(summary.PatientId, summary.DoctorId, summary.HospitalId),
            summary.PrescriptionId
                ? AppDataSource.getRepository(PatientPrescription).findOne({ where: { Id: summary.PrescriptionId }, relations: { Medications: true, Diagnoses: true } })
                : Promise.resolve(null),
            summary.DocumentId ? this.document(summary.DocumentId) : Promise.resolve(null),
        ]);
        return {
            summary, parties, document,
            medications: (prescription?.Medications ?? []).map((m) => this.medication(m, prescription?.Notes)),
            prescriptionDiagnoses: (prescription?.Diagnoses ?? []).flatMap((d) => codedText(d.Diagnosis, d.DiagnosisConceptId)),
        };
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
        row.Date = medicalRecordDate(row);
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
     * confidential (one attached to a discharge summary, an immunization or a diagnostic report
     * travels with that), Final diagnostic reports, and wellness records.
     */
    async standaloneRecords(patientId: string, hospitalId: number) {
        const q = (sql: string) => AppDataSource.query(sql, [patientId, hospitalId]);
        const noVisit = (column: string) => `(${column} IS NULL OR CAST(${column} AS VARCHAR(40)) IN ('', '0'))`;
        const [prescriptions, records, notes, documents, reports, wellness] = await Promise.all([
            // A discharge summary's prescription travels with the summary
            q(`SELECT p.Id, p.Date, p.CreatedAt FROM PatientPrescription p
               WHERE p.PatientId = @0 AND p.HospitalId = @1 AND ${noVisit("p.AppointmentId")}
                 AND EXISTS (SELECT 1 FROM PrescriptionMedication m WHERE m.PrescriptionId = p.Id)
                 AND NOT EXISTS (SELECT 1 FROM DischargeSummaries s WHERE s.PrescriptionId = p.Id AND s.IsDeleted = 0)`),
            AppDataSource.getRepository(PatientMedicalRecord).find({
                where: [IsNull(), 0].map((AppointmentId) => ({ PatientId: patientId, HospitalId: hospitalId, AppointmentId })),
            }),
            q(`SELECT Id, CreatedAt, CreatedBy FROM PatientClinicalNotes
               WHERE PatientId = @0 AND HospitalId = @1 AND ${noVisit("AppointmentId")} AND LEN(LTRIM(RTRIM(COALESCE(Notes, '')))) > 0`),
            // A prescription's PDF (its archive copy, or an upload overwritten with one) is the prescription's
            q(`SELECT d.Id, d.CreatedAt, d.CreatedBy, d.DocumentCategory FROM MedicalDocuments d
               WHERE d.PatientId = @0 AND d.HospitalId = @1 AND ${noVisit("d.AppointmentId")} AND d.IsDeleted = 0
                 AND d.IsShareable = 1 AND d.IsConfidential = 0 AND d.IsPatientUploaded = 0
                 AND COALESCE(d.DocumentCategory, '') NOT LIKE '%insurance%'
                 AND NOT EXISTS (SELECT 1 FROM PatientPrescription p
                     WHERE (p.PdfUrl = d.BlobUrl OR d.FileName = 'Prescription_' + CAST(p.Id AS VARCHAR(36)) + '.pdf')
                       AND EXISTS (SELECT 1 FROM PrescriptionMedication m WHERE m.PrescriptionId = p.Id))
                 AND NOT EXISTS (SELECT 1 FROM DischargeSummaries s WHERE s.DocumentId = d.Id AND s.IsDeleted = 0)
                 AND NOT EXISTS (SELECT 1 FROM PatientImmunizations i WHERE i.CertificateDocumentId = d.Id AND i.IsDeleted = 0)
                 AND NOT EXISTS (SELECT 1 FROM DiagnosticReports r WHERE r.DocumentId = d.Id AND r.IsDeleted = 0)`),
            q(`SELECT Id, IssuedAt, Category FROM DiagnosticReports WHERE PatientId = @0 AND HospitalId = @1 AND Status = 'Final' AND IsDeleted = 0`),
            q(`SELECT Id, RecordedAt FROM WellnessRecords WHERE PatientId = @0 AND HospitalId = @1 AND IsDeleted = 0`),
        ]);
        return {
            prescriptions: prescriptions.map((r: any) => ({ id: String(r.Id), date: prescriptionDate(r) ?? new Date(r.CreatedAt) })),
            consultations: records.filter((r) => !isVitalsRecord(r) && hasConsultationContent(r)).map((r) => ({ id: r.Id, date: medicalRecordDate(r) })),
            notes: notes.map((r: any) => ({ id: Number(r.Id), date: rowTime(r.CreatedAt, r.CreatedBy !== PULSE_NOTE) })),
            documents: documents.map((r: any) => ({ id: Number(r.Id), date: rowTime(r.CreatedAt, r.CreatedBy !== PULSE_DOCUMENT), category: r.DocumentCategory ?? null })),
            reports: reports.map((r: any) => ({ id: Number(r.Id), date: new Date(r.IssuedAt), category: String(r.Category) })),
            wellness: wellness.map((r: any) => ({ id: Number(r.Id), date: new Date(r.RecordedAt) })),
        };
    }

    /** A prescription saved outside a visit, with its medicines, diagnoses and the clinic's PDF. */
    async prescription(id: string) {
        const row = await AppDataSource.getRepository(PatientPrescription).findOne({ where: { Id: id }, relations: { Medications: true, Diagnoses: true } });
        if (!row) throw new Error(`Prescription ${id} not found.`);
        if (!row.HospitalId) throw new Error(`Prescription ${id} names no hospital, so no facility can share it.`);
        row.Date = prescriptionDate(row);
        const [parties, pdf] = await Promise.all([
            this.parties(row.PatientId, row.DoctorId, row.HospitalId),
            row.PdfUrl && /^https:\/\/[^/]+\.blob\.core\.windows\.net\//.test(row.PdfUrl) ? this.tryRead(row.PdfUrl) : Promise.resolve(null),
        ]);
        return {
            row, parties, pdf,
            medications: (row.Medications ?? []).map((m) => this.medication(m, row.Notes)),
            diagnoses: (row.Diagnoses ?? []).flatMap((d) => codedText(d.Diagnosis, d.DiagnosisConceptId)),
        };
    }

    /** A consultation record (a PatientMedicalRecord that is not a vitals check) saved outside a visit. */
    async consultationRecord(id: string) {
        const row = await AppDataSource.getRepository(PatientMedicalRecord).findOne({ where: { Id: id } });
        if (!row) throw new Error(`Medical record ${id} not found.`);
        if (!row.HospitalId) throw new Error(`Medical record ${id} names no hospital, so no facility can share it.`);
        row.Date = medicalRecordDate(row);
        return { row, parties: await this.parties(row.PatientId, row.DoctorId, row.HospitalId) };
    }

    /** A clinical note saved outside a visit. */
    async clinicalNote(id: number) {
        const row = await AppDataSource.getRepository(ClinicalNote).findOne({ where: { Id: id } });
        if (!row) throw new Error(`Clinical note ${id} not found.`);
        if (!row.HospitalId) throw new Error(`Clinical note ${id} names no hospital, so no facility can share it.`);
        row.CreatedAt = rowTime(row.CreatedAt, row.CreatedBy !== PULSE_NOTE);
        return { row, parties: await this.parties(row.PatientId, row.DoctorId, Number(row.HospitalId)) };
    }

    /** A lab or imaging report entered at the clinic, with its attached file, and the visit it was entered at. */
    async diagnosticReport(id: number) {
        const row = await AppDataSource.getRepository(PatientDiagnosticReport).findOne({ where: { Id: id, IsDeleted: false } });
        if (!row) throw new Error(`Diagnostic report ${id} not found.`);
        const [parties, document, visit] = await Promise.all([
            this.parties(row.PatientId, row.DoctorId, row.HospitalId),
            row.DocumentId ? this.document(row.DocumentId) : Promise.resolve(null),
            this.visitRef(row.AppointmentId, row.PatientId, row.HospitalId),
        ]);
        return { row, parties: visit ? { ...parties, visit } : parties, document };
    }

    /** A wellness check recorded at the clinic, with the visit it was recorded at. */
    async wellnessRecord(id: number) {
        const row = await AppDataSource.getRepository(WellnessRecord).findOne({ where: { Id: id, IsDeleted: false } });
        if (!row) throw new Error(`Wellness record ${id} not found.`);
        const [parties, visit] = await Promise.all([
            this.parties(row.PatientId, row.RecordedById, row.HospitalId),
            this.visitRef(row.AppointmentId, row.PatientId, row.HospitalId),
        ]);
        return { row, parties: visit ? { ...parties, visit } : parties };
    }

    /** The visit a record names, when it is the same patient's at the same hospital: every record of a visit shares its encounter. */
    private async visitRef(appointmentId: number | null | undefined, patientId: string, hospitalId: number): Promise<VisitRef | null> {
        if (!appointmentId) return null;
        return visitOf(await AppDataSource.getRepository(Appointment).findOne({ where: { Id: appointmentId } }), patientId, hospitalId);
    }

    /** A document the clinic uploaded outside a visit, with its file. */
    async standaloneDocument(id: number) {
        const row = await AppDataSource.getRepository(MedicalDocument).findOne({ where: { Id: id, IsDeleted: false } });
        if (!row) throw new Error(`Document ${id} not found.`);
        const [parties, document] = await Promise.all([this.parties(row.PatientId, row.DoctorId, Number(row.HospitalId)), this.document(id)]);
        return { parties, document };
    }

    private medication(m: { Id: string; Medication: string; ConceptId?: string; Dosage?: string; DurationValue?: number; DurationUnit?: string; FrequencyType?: string; Route?: string; Instructions?: string }, prescriptionNotes?: string | null): MedicationSource {
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
            prescriptionNotes: prescriptionNotes?.trim() || null,
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
            createdAt: rowTime(d.CreatedAt, d.CreatedBy !== PULSE_DOCUMENT),
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
