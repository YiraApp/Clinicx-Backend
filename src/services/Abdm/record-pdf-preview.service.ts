import { codedText, resourceId, type HiType } from "./fhir/fhir-common.js";
import { recordPdfOf, type RecordPdf } from "./fhir/record-pdf.js";
import { AbdmHealthRecordService, issuedBill, type HealthRecordBundle } from "./abdm-health-record.service.js";
import { careContextReference } from "./m2/care-contexts.js";
import {
    abdmHealthRecordRepository, isVitalsRecord, type AbdmHealthRecordRepository, type VisitRecords,
} from "../../repositories/Abdm/abdm-health-record.repository.js";
import { medicalRecordColumns } from "../Appointments/medical-record-mapping.js";
import { buildPrescriptionHeader } from "../Appointments/prescription-mapping.js";
import { immunizationColumns } from "../Appointments/immunization.service.js";
import { checkWellness, wellnessColumns } from "../Appointments/wellness-record.service.js";
import { checkReport, diagnosticReportColumns } from "../Appointments/diagnostic-report.service.js";
import { checkDates, dischargeSummaryColumns } from "../Appointments/discharge-summary.service.js";
import type { ClinicPrescription } from "../../MobileApi/v1/controllers/provider/prescription.controller.js";

/**
 * The PDF a record carries to ABDM, for staff to see: from a form's unsaved fields (preview), or for
 * a saved record at any time. Both go the way a consented fetch does (rows, then visitSources or a
 * forX mapping, then the builders, then the record's PDF), so what staff see is what is sent.
 * A preview writes nothing.
 */

export const RECORD_PDF_TYPES = [
    "consultation", "prescription", "clinical-note", "immunization", "wellness", "diagnostic-report", "discharge-summary", "invoice",
] as const;
export type RecordPdfType = (typeof RECORD_PDF_TYPES)[number];
export const isRecordPdfType = (value: unknown): value is RecordPdfType => (RECORD_PDF_TYPES as readonly string[]).includes(String(value));

/** A request that can't be answered as asked: the status, and the reason in staff's words. */
export class RecordPdfError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

export interface RecordPdfContext {
    patientId: string;
    hospitalId: number;
    /** The signed-in staff member: who records a wellness check. */
    staffUserId?: string | null;
}

export interface PreviewRequest extends RecordPdfContext {
    type: RecordPdfType;
    /** Exactly what the form sends to its own create or update endpoint. */
    draft: Record<string, any>;
    appointmentId?: number | null;
    /** The saved record being edited, if any. */
    recordId?: string | null;
    billId?: string | null;
}

/** Where a record's PDF sits in ABDM: its care context and the record (one HI type) within it. */
export interface RecordLocation {
    reference: string;
    hiType: HiType;
    /** The builder's key for the record; its bundle id is resourceId("Bundle:<hiType>", key). */
    recordKey: string;
}

export const bundleIdOf = (loc: Pick<RecordLocation, "hiType" | "recordKey">): string => resourceId(`Bundle:${loc.hiType}`, loc.recordKey);

export interface RecordPdfOut extends RecordLocation {
    pdf: RecordPdf;
    /** Not shared yet (a Draft report or summary, a bill not issued): shown as it will be. */
    draft: boolean;
}

type Repo = Pick<AbdmHealthRecordRepository,
    "parties" | "visit" | "providerAt" | "visitRef" | "document" | "certificates" | "medication" | "bill" | "prescriptionParts"
    | "immunization" | "wellnessRecord" | "diagnosticReport" | "dischargeSummary" | "prescription" | "consultationRecord" | "clinicalNote"
    | "vitalsRecord" | "standaloneDocument">;

const same = (a: unknown, b: unknown) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const positiveId = (value: unknown): number | null => {
    const n = Number(String(value ?? "").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
};
/** Only the fields the form filled in: a mapper's undefined never overwrites a saved value. */
const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
/** A form's fields that don't make a record yet: the mapper's own message, as a 422. */
const checked = <T>(fn: () => T): T => {
    try {
        return fn();
    } catch (error: any) {
        if (error instanceof RecordPdfError) throw error;
        throw new RecordPdfError(422, error?.message || "The record isn't complete yet.");
    }
};

const visitRef = (appointmentId: number) => careContextReference("visit", appointmentId);

export class RecordPdfService {
    constructor(
        private readonly repo: Repo = abdmHealthRecordRepository,
        private readonly now: () => Date = () => new Date(),
        /** The clinic's own prescription PDF, made from a prescription saved or not (loaded only when needed). */
        private readonly renderPrescriptionPdf: (p: ClinicPrescription) => Promise<Buffer> = async (p) =>
            (await (await import("../../MobileApi/v1/controllers/provider/prescription.controller.js")).renderClinicPrescriptionPdf(p)).pdf,
    ) {}

    // ---- preview: from a form's unsaved fields ----------------------------------------------------

    async preview(req: PreviewRequest): Promise<RecordPdfOut> {
        // The patient and hospital are the request's, whatever the form says
        const draft = { ...(req.draft ?? {}), patientId: req.patientId, hospitalId: req.hospitalId };
        switch (req.type) {
            case "consultation": return this.previewConsultation(req, draft);
            case "clinical-note": return this.previewNote(req, draft);
            case "prescription": return this.previewPrescription(req, draft);
            case "immunization": return this.previewImmunization(req, draft);
            case "wellness": return this.previewWellness(req, draft);
            case "diagnostic-report": return this.previewReport(req, draft);
            case "discharge-summary": return this.previewDischarge(req, draft);
            case "invoice": {
                const billId = String(req.billId ?? req.recordId ?? "").trim();
                if (!billId) throw new RecordPdfError(400, "billId is required to preview an invoice.");
                const bill = await this.repo.bill(billId);
                this.own(bill, req);
                return this.invoice(req, bill);
            }
        }
    }

    private async previewConsultation(req: PreviewRequest, draft: Record<string, any>): Promise<RecordPdfOut> {
        const editing = req.recordId ? (await this.repo.consultationRecord(String(req.recordId))).row : null;
        if (editing) this.own(editing, req);
        const cols = defined(medicalRecordColumns(draft));
        const appointmentId = positiveId(cols.AppointmentId ?? editing?.AppointmentId ?? req.appointmentId);
        const now = this.now();
        const row: any = {
            ...(editing ?? {}), ...cols,
            Id: editing?.Id ?? "preview", PatientId: req.patientId, HospitalId: req.hospitalId, AppointmentId: appointmentId,
            Date: editing?.Date ?? now, CreatedAt: editing?.CreatedAt ?? now,
        };
        const vitals = isVitalsRecord(row);
        const empty = vitals ? "Enter at least one measurement to preview the vitals." : "Write something in the consultation to preview it.";
        if (appointmentId) {
            const v = await this.visit(req, appointmentId);
            v.medicalRecords = [...v.medicalRecords.filter((r) => r.Id !== row.Id), row];
            return this.fromVisit(v, {
                reference: visitRef(appointmentId),
                hiType: vitals ? "WellnessRecord" : "OPConsultation",
                recordKey: vitals ? `appointment-${appointmentId}:wellness` : `appointment-${appointmentId}`,
            }, false, empty);
        }
        const parties = await this.repo.parties(req.patientId, row.DoctorId, req.hospitalId);
        if (vitals) {
            const bundles = await this.records({ vitalsRecord: async () => ({ row, parties }) }).forVitalsRecord(row.Id);
            return this.pick(bundles, { reference: careContextReference("vitals", row.Id), hiType: "WellnessRecord", recordKey: `vitals-${row.Id}` }, false, empty);
        }
        const bundles = await this.records({ consultationRecord: async () => ({ row, parties }) }).forConsultationRecord(row.Id);
        return this.pick(bundles, { reference: careContextReference("consultation", row.Id), hiType: "OPConsultation", recordKey: `medical-record-${row.Id}` }, false, empty);
    }

    private async previewNote(req: PreviewRequest, draft: Record<string, any>): Promise<RecordPdfOut> {
        const text = String(draft.notes ?? draft.Notes ?? "").trim();
        if (!text) throw new RecordPdfError(422, "Write the note to preview it.");
        const editing = req.recordId ? (await this.repo.clinicalNote(Number(req.recordId))).row : null;
        if (editing) this.own(editing, req);
        const appointmentId = positiveId(draft.appointmentId ?? editing?.AppointmentId ?? req.appointmentId);
        const id = editing ? Number(editing.Id) : 0;
        const at = editing?.CreatedAt ? new Date(editing.CreatedAt) : this.now();
        if (appointmentId) {
            const v = await this.visit(req, appointmentId);
            v.notes = [...v.notes.filter((n) => !editing || n.id !== id), { id, text, at }].sort((a, b) => a.at.getTime() - b.at.getTime());
            return this.fromVisit(v, { reference: visitRef(appointmentId), hiType: "OPConsultation", recordKey: `appointment-${appointmentId}` }, false, "Write the note to preview it.");
        }
        const parties = await this.repo.parties(req.patientId, draft.doctorId ?? editing?.DoctorId ?? null, req.hospitalId);
        const row: any = { ...(editing ?? {}), Id: id, Notes: text, CreatedAt: at, PatientId: req.patientId, HospitalId: req.hospitalId };
        const bundles = await this.records({ clinicalNote: async () => ({ row, parties }) }).forClinicalNote(id);
        return this.pick(bundles, { reference: careContextReference("note", id), hiType: "OPConsultation", recordKey: `clinical-note-${id}` }, false, "Write the note to preview it.");
    }

    private async previewPrescription(req: PreviewRequest, draft: Record<string, any>): Promise<RecordPdfOut> {
        const editing = req.recordId ? await this.repo.prescription(String(req.recordId)) : null;
        if (editing) this.own(editing.row, req);
        const header = buildPrescriptionHeader({ ...draft, doctorId: draft.doctorId ?? editing?.row.DoctorId });
        const empty = "Add at least one medicine to preview the prescription.";
        if (!header.Medications.length) throw new RecordPdfError(422, empty);
        const id = editing?.row.Id ?? "preview";
        const now = this.now();
        const appointmentId = positiveId(header.AppointmentId ?? editing?.row.AppointmentId ?? req.appointmentId);
        const medications = header.Medications.map((m: any, i: number) => this.repo.medication({ ...m, Id: `${id}-${i}` }, header.Notes));
        const diagnoses = header.Diagnoses.flatMap((d: any) => codedText(d.Diagnosis, d.DiagnosisConceptId));
        // Once saved, the clinic's own PDF of it is what ABDM gets; a manual one (no doctor) has none
        const pdf = header.DoctorId
            ? await this.renderPrescriptionPdf({
                Id: id, PatientId: req.patientId, DoctorId: header.DoctorId, HospitalId: req.hospitalId,
                PrescriptionNumber: editing?.row.PrescriptionNumber ?? null, CreatedAt: editing?.row.CreatedAt ?? now,
                AppointmentId: appointmentId, Notes: header.Notes, Medications: header.Medications, Diagnoses: header.Diagnoses,
            })
            : null;
        const row: any = {
            ...(editing?.row ?? {}),
            Id: id, PatientId: req.patientId, HospitalId: req.hospitalId, DoctorId: header.DoctorId,
            AppointmentId: appointmentId ? String(appointmentId) : null, Notes: header.Notes,
            Date: editing?.row.Date ?? now, CreatedAt: editing?.row.CreatedAt ?? now,
        };
        if (appointmentId) {
            const v = await this.visit(req, appointmentId);
            const practitioner = header.DoctorId && !same(header.DoctorId, v.parties.practitioner.id) ? await this.repo.providerAt(header.DoctorId, req.hospitalId) : null;
            v.prescriptions = [...v.prescriptions.filter((p) => p.row.Id !== id), { row, medications, diagnoses, pdf, practitioner }];
            return this.fromVisit(v, { reference: visitRef(appointmentId), hiType: "Prescription", recordKey: `prescription-${id}` }, false, empty);
        }
        const parties = await this.repo.parties(req.patientId, header.DoctorId, req.hospitalId);
        const bundles = await this.records({ prescription: async () => ({ row, parties, pdf, medications, diagnoses }) }).forPrescription(id);
        return this.pick(bundles, { reference: careContextReference("prescription", id), hiType: "Prescription", recordKey: `prescription-${id}` }, false, empty);
    }

    private async previewImmunization(req: PreviewRequest, draft: Record<string, any>): Promise<RecordPdfOut> {
        const editing = req.recordId ? (await this.repo.immunization(Number(req.recordId))).row : null;
        if (editing) this.own(editing, req);
        const cols = checked(() => immunizationColumns(draft, Boolean(editing)));
        const row: any = { ...(editing ?? {}), ...cols, Id: editing?.Id ?? 0, PatientId: req.patientId, HospitalId: req.hospitalId, IsDeleted: false };
        const empty = "Enter the vaccine to preview the record.";
        const appointmentId = positiveId(row.AppointmentId);
        if (appointmentId) {
            const v = await this.visit(req, appointmentId);
            v.immunizations = [...v.immunizations.filter((i) => i.Id !== row.Id), row];
            const doctor = row.DoctorId ? String(row.DoctorId).toLowerCase() : null;
            if (doctor && !v.givenBy?.has(doctor)) {
                const p = await this.repo.providerAt(row.DoctorId, req.hospitalId);
                if (p) (v.givenBy ??= new Map()).set(doctor, p);
            }
            if (row.CertificateDocumentId && !v.certificates.has(row.CertificateDocumentId)) {
                for (const [k, d] of await this.repo.certificates([row])) v.certificates.set(k, d);
            }
            return this.fromVisit(v, { reference: visitRef(appointmentId), hiType: "ImmunizationRecord", recordKey: `appointment-${appointmentId}:immunizations` }, false, empty);
        }
        const [parties, certificates] = await Promise.all([this.repo.parties(req.patientId, row.DoctorId, req.hospitalId), this.repo.certificates([row])]);
        const bundles = await this.records({ immunization: async () => ({ row, parties, certificates }) }).forImmunization(row.Id);
        return this.pick(bundles, { reference: careContextReference("immunization", row.Id), hiType: "ImmunizationRecord", recordKey: `immunization-${row.Id}` }, false, empty);
    }

    private async previewWellness(req: PreviewRequest, draft: Record<string, any>): Promise<RecordPdfOut> {
        const editing = req.recordId ? (await this.repo.wellnessRecord(Number(req.recordId))).row : null;
        if (editing) this.own(editing, req);
        const cols = checked(() => wellnessColumns(draft, Boolean(editing)));
        const row: any = {
            ...(editing ?? {}), ...cols,
            Id: editing?.Id ?? 0, PatientId: req.patientId, HospitalId: req.hospitalId, IsDeleted: false,
            RecordedAt: (cols as any).RecordedAt ?? editing?.RecordedAt ?? this.now(),
            RecordedById: editing?.RecordedById ?? req.staffUserId ?? null,
        };
        checked(() => checkWellness(row, this.now()));
        return this.wellness(req, row, false);
    }

    private async previewReport(req: PreviewRequest, draft: Record<string, any>): Promise<RecordPdfOut> {
        const editing = req.recordId ? (await this.repo.diagnosticReport(Number(req.recordId))).row : null;
        if (editing) this.own(editing, req);
        const cols = checked(() => diagnosticReportColumns(draft, Boolean(editing)));
        // Previewed as it will be shared: once it is Final
        const row: any = { ...(editing ?? {}), ...cols, Id: editing?.Id ?? 0, PatientId: req.patientId, HospitalId: req.hospitalId, Status: "Final", IsDeleted: false };
        checked(() => checkReport(row, this.now()));
        return this.report(req, row, false);
    }

    private async previewDischarge(req: PreviewRequest, draft: Record<string, any>): Promise<RecordPdfOut> {
        const editing = req.recordId ? (await this.repo.dischargeSummary(Number(req.recordId))).summary : null;
        if (editing) this.own(editing, req);
        const cols = checked(() => dischargeSummaryColumns(draft, Boolean(editing)));
        const row: any = { ...(editing ?? {}), ...cols, Id: editing?.Id ?? 0, PatientId: req.patientId, HospitalId: req.hospitalId, Status: "Final", IsDeleted: false };
        checked(() => checkDates(row, this.now()));
        return this.discharge(req, row, false);
    }

    // ---- a saved record, at any time --------------------------------------------------------------

    async saved(ctx: RecordPdfContext & { type: RecordPdfType; id: string }): Promise<RecordPdfOut> {
        return (await this.resolve(ctx)).build();
    }

    /** Where a saved record's PDF sits in ABDM, without building it. */
    async locate(ctx: RecordPdfContext & { type: RecordPdfType; id: string }): Promise<RecordLocation> {
        return (await this.resolve(ctx)).loc;
    }

    private async resolve(ctx: RecordPdfContext & { type: RecordPdfType; id: string }): Promise<{ loc: RecordLocation; build: () => Promise<RecordPdfOut> }> {
        const svc = new AbdmHealthRecordService(this.repo, this.now, true);
        const id = String(ctx.id);
        switch (ctx.type) {
            case "consultation": {
                const { row } = await this.repo.consultationRecord(id);
                this.own(row, ctx);
                const appointmentId = positiveId(row.AppointmentId);
                const vitals = isVitalsRecord(row);
                const empty = vitals ? "This vitals check has no measurements to share." : "This consultation has nothing written to share yet.";
                if (appointmentId) {
                    const loc: RecordLocation = {
                        reference: visitRef(appointmentId),
                        hiType: vitals ? "WellnessRecord" : "OPConsultation",
                        recordKey: vitals ? `appointment-${appointmentId}:wellness` : `appointment-${appointmentId}`,
                    };
                    return { loc, build: async () => this.fromVisit(await this.visit(ctx, appointmentId), loc, false, empty) };
                }
                const loc: RecordLocation = vitals
                    ? { reference: careContextReference("vitals", id), hiType: "WellnessRecord", recordKey: `vitals-${id}` }
                    : { reference: careContextReference("consultation", id), hiType: "OPConsultation", recordKey: `medical-record-${id}` };
                return { loc, build: async () => this.pick(vitals ? await svc.forVitalsRecord(id) : await svc.forConsultationRecord(id), loc, false, empty) };
            }
            case "prescription": {
                const { row } = await this.repo.prescription(id);
                this.own(row, ctx);
                const appointmentId = positiveId(row.AppointmentId);
                const empty = "This prescription has no medicines, so it isn't shared as a prescription.";
                if (appointmentId) {
                    const loc: RecordLocation = { reference: visitRef(appointmentId), hiType: "Prescription", recordKey: `prescription-${id}` };
                    return { loc, build: async () => this.fromVisit(await this.visit(ctx, appointmentId), loc, false, empty) };
                }
                const loc: RecordLocation = { reference: careContextReference("prescription", id), hiType: "Prescription", recordKey: `prescription-${id}` };
                return { loc, build: async () => this.pick(await svc.forPrescription(id), loc, false, empty) };
            }
            case "clinical-note": {
                const { row } = await this.repo.clinicalNote(Number(id));
                this.own(row, ctx);
                const appointmentId = positiveId(row.AppointmentId);
                const empty = "This note is empty, so nothing is shared.";
                if (appointmentId) {
                    const loc: RecordLocation = { reference: visitRef(appointmentId), hiType: "OPConsultation", recordKey: `appointment-${appointmentId}` };
                    return { loc, build: async () => this.fromVisit(await this.visit(ctx, appointmentId), loc, false, empty) };
                }
                const loc: RecordLocation = { reference: careContextReference("note", id), hiType: "OPConsultation", recordKey: `clinical-note-${id}` };
                return { loc, build: async () => this.pick(await svc.forClinicalNote(Number(id)), loc, false, empty) };
            }
            case "immunization": {
                const { row } = await this.repo.immunization(Number(id));
                this.own(row, ctx);
                const appointmentId = positiveId(row.AppointmentId);
                if (appointmentId) {
                    const loc: RecordLocation = { reference: visitRef(appointmentId), hiType: "ImmunizationRecord", recordKey: `appointment-${appointmentId}:immunizations` };
                    return { loc, build: async () => this.fromVisit(await this.visit(ctx, appointmentId), loc, false, "This visit has no vaccines to share.") };
                }
                const loc: RecordLocation = { reference: careContextReference("immunization", id), hiType: "ImmunizationRecord", recordKey: `immunization-${id}` };
                return { loc, build: async () => this.pick(await svc.forImmunization(Number(id)), loc, false, "This immunization can't be shared yet.") };
            }
            case "wellness": {
                const { row } = await this.repo.wellnessRecord(Number(id));
                this.own(row, ctx);
                const loc: RecordLocation = { reference: careContextReference("wellness", id), hiType: "WellnessRecord", recordKey: `wellness-record-${id}` };
                return { loc, build: async () => this.pick(await svc.forWellnessRecord(Number(id)), loc, false, "This wellness record has no measurements to share.") };
            }
            case "diagnostic-report": {
                const { row } = await this.repo.diagnosticReport(Number(id));
                this.own(row, ctx);
                const loc: RecordLocation = { reference: careContextReference("report", id), hiType: "DiagnosticReport", recordKey: `diagnostic-report-${id}` };
                const final = row.Status === "Final";
                return {
                    loc,
                    build: async () => final
                        ? this.pick(await svc.forDiagnosticReport(Number(id)), loc, false, "This report can't be shared yet.")
                        : this.report(ctx, { ...row, Status: "Final" }, true),
                };
            }
            case "discharge-summary": {
                const { summary } = await this.repo.dischargeSummary(Number(id));
                this.own(summary, ctx);
                const loc: RecordLocation = { reference: careContextReference("discharge", id), hiType: "DischargeSummary", recordKey: `discharge-${id}` };
                const final = summary.Status === "Final";
                return {
                    loc,
                    build: async () => final
                        ? this.pick(await svc.forDischargeSummary(Number(id)), loc, false, "This discharge summary can't be shared yet.")
                        : this.discharge(ctx, { ...summary, Status: "Final" }, true),
                };
            }
            case "invoice": {
                const bill = await this.repo.bill(id);
                this.own(bill, ctx);
                const appointmentId = positiveId(bill.AppointmentId);
                if (!appointmentId) throw new RecordPdfError(422, "Only a visit's bill is shared through ABDM, and this one belongs to no visit.");
                const loc: RecordLocation = { reference: visitRef(appointmentId), hiType: "Invoice", recordKey: `bill-${bill.AppointmentBillId}` };
                return { loc, build: () => this.invoice(ctx, bill) };
            }
        }
    }

    // ---- shared by preview and saved --------------------------------------------------------------

    private async wellness(ctx: RecordPdfContext, row: any, draft: boolean): Promise<RecordPdfOut> {
        const [parties, visit] = await Promise.all([
            this.repo.parties(ctx.patientId, row.RecordedById, ctx.hospitalId),
            this.repo.visitRef(row.AppointmentId, ctx.patientId, ctx.hospitalId),
        ]);
        const bundles = await this.records({ wellnessRecord: async () => ({ row, parties: visit ? { ...parties, visit } : parties }) }).forWellnessRecord(row.Id);
        return this.pick(bundles, { reference: careContextReference("wellness", row.Id), hiType: "WellnessRecord", recordKey: `wellness-record-${row.Id}` }, draft, "Record at least one measurement to preview it.");
    }

    private async report(ctx: RecordPdfContext, row: any, draft: boolean): Promise<RecordPdfOut> {
        const [parties, document, visit] = await Promise.all([
            this.repo.parties(ctx.patientId, row.DoctorId, ctx.hospitalId),
            row.DocumentId ? this.repo.document(row.DocumentId) : Promise.resolve(null),
            this.repo.visitRef(row.AppointmentId, ctx.patientId, ctx.hospitalId),
        ]);
        const bundles = await this.records({ diagnosticReport: async () => ({ row, parties: visit ? { ...parties, visit } : parties, document }) }).forDiagnosticReport(row.Id);
        return this.pick(bundles, { reference: careContextReference("report", row.Id), hiType: "DiagnosticReport", recordKey: `diagnostic-report-${row.Id}` }, draft, "Complete the report to preview it.");
    }

    private async discharge(ctx: RecordPdfContext, summary: any, draft: boolean): Promise<RecordPdfOut> {
        const [parties, document, parts] = await Promise.all([
            this.repo.parties(ctx.patientId, summary.DoctorId, ctx.hospitalId),
            summary.DocumentId ? this.repo.document(summary.DocumentId) : Promise.resolve(null),
            summary.PrescriptionId ? this.repo.prescriptionParts(summary.PrescriptionId) : Promise.resolve({ medications: [], diagnoses: [] }),
        ]);
        const bundles = await this.records({
            dischargeSummary: async () => ({ summary, parties, document, medications: parts.medications, prescriptionDiagnoses: parts.diagnoses }),
        }).forDischargeSummary(summary.Id);
        return this.pick(bundles, { reference: careContextReference("discharge", summary.Id), hiType: "DischargeSummary", recordKey: `discharge-${summary.Id}` }, draft, "Complete the discharge summary to preview it.");
    }

    /** A visit's bill as its invoice: one not issued yet is shown as it will be once issued (its number comes then). */
    private async invoice(ctx: RecordPdfContext, bill: any): Promise<RecordPdfOut> {
        const appointmentId = positiveId(bill.AppointmentId);
        if (!appointmentId) throw new RecordPdfError(422, "Only a visit's bill is shared through ABDM, and this one belongs to no visit.");
        const issued = issuedBill(bill);
        const asShared = issued ? bill : { ...bill, BillStatus: "Pending", BillNumber: "(assigned when issued)" };
        const v = await this.visit(ctx, appointmentId);
        v.bills = [...v.bills.filter((b) => b.AppointmentBillId !== bill.AppointmentBillId), asShared];
        return this.fromVisit(v, { reference: visitRef(appointmentId), hiType: "Invoice", recordKey: `bill-${bill.AppointmentBillId}` }, !issued, "Add an item to the bill to preview its invoice.");
    }

    /** The visit's records as saved, for the patient at this hospital only. */
    private async visit(ctx: RecordPdfContext, appointmentId: number): Promise<VisitRecords> {
        const v = await this.repo.visit(appointmentId);
        if (!same(v.parties.patient.id, ctx.patientId) || Number(v.parties.organization.id) !== Number(ctx.hospitalId)) {
            throw new RecordPdfError(404, "That visit isn't this patient's at this hospital.");
        }
        return v;
    }

    private async fromVisit(v: VisitRecords, loc: RecordLocation, draft: boolean, empty: string): Promise<RecordPdfOut> {
        const bundles = await this.records({ visit: async () => v }).forAppointment(v.appointment.id, [loc.hiType]);
        return this.pick(bundles, loc, draft, empty);
    }

    /** The record service over [stub]: strict, so a record that can't be built says why. */
    private records(stub: Partial<Repo>): AbdmHealthRecordService {
        return new AbdmHealthRecordService(stub as any, this.now, true);
    }

    private pick(bundles: HealthRecordBundle[], loc: RecordLocation, draft: boolean, empty: string): RecordPdfOut {
        const bundleId = bundleIdOf(loc);
        const found = bundles.find((b) => b.hiType === loc.hiType && b.key === bundleId);
        if (!found) throw new RecordPdfError(422, empty);
        const pdf = recordPdfOf(found.bundle);
        if (!pdf) throw new RecordPdfError(422, "This record carries no PDF of its own: its uploaded files are sent as they are.");
        return { ...loc, pdf, draft };
    }

    private own(row: { PatientId?: unknown; HospitalId?: unknown }, ctx: RecordPdfContext): void {
        if (!same(row.PatientId, ctx.patientId) || Number(row.HospitalId) !== Number(ctx.hospitalId)) {
            throw new RecordPdfError(404, "That record isn't this patient's at this hospital.");
        }
    }
}

export const recordPdfService = new RecordPdfService();
