import { AppDataSource } from "../../config/database.js";
import { DischargeSummary } from "../../models/Appointments/discharge-summary.model.js";

/** Discharge summaries, which ABDM shares as a DischargeSummary once they are Final. */

export interface CodedTextInput {
    text: string;
    conceptId?: string | null;
}

export interface DischargeSummaryInput {
    patientId: string;
    hospitalId: number;
    organizationId?: number | null;
    doctorId: string;
    admittedAt: string;
    dischargedAt: string;
    chiefComplaints?: CodedTextInput[];
    diagnoses?: CodedTextInput[];
    medicalHistory?: CodedTextInput[];
    examinationFindings?: CodedTextInput[];
    procedures?: CodedTextInput[];
    allergies?: string | null;
    investigations?: string | null;
    prescriptionId?: string | null;
    carePlan?: string | null;
    followUpDate?: string | null;
    disposition?: string | null;
    documentId?: number | null;
    status?: "Draft" | "Final";
}

const LISTS = {
    chiefComplaints: "ChiefComplaints",
    diagnoses: "Diagnoses",
    medicalHistory: "MedicalHistory",
    examinationFindings: "ExaminationFindings",
    procedures: "Procedures",
} as const;

/** A list of { text, conceptId? } as stored: JSON, each text present, each concept a SNOMED CT id. */
export const codedList = (value: unknown, name: string): string | null => {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value)) throw new Error(`${name} must be a list of { text, conceptId }.`);
    const items = value.map((item, i) => {
        const textValue = typeof item === "string" ? item : item?.text;
        if (typeof textValue !== "string" || !textValue.trim()) throw new Error(`${name}[${i}] needs text.`);
        const conceptId = typeof item === "object" && item?.conceptId ? String(item.conceptId).trim() : null;
        if (conceptId && !/^\d{6,18}$/.test(conceptId)) throw new Error(`${name}[${i}].conceptId must be a SNOMED CT concept id.`);
        return conceptId ? { text: textValue.trim(), conceptId } : { text: textValue.trim() };
    });
    return items.length ? JSON.stringify(items) : null;
};

const optionalText = (value: unknown): string | null =>
    value === undefined || value === null || String(value).trim() === "" ? null : String(value).trim();

const dateTime = (value: unknown, name: string): Date => {
    const d = new Date(String(value ?? ""));
    if (!value || Number.isNaN(d.getTime())) throw new Error(`${name} must be a date and time.`);
    return d;
};

export const dischargeSummaryColumns = (input: Partial<DischargeSummaryInput>, partial = false): Partial<DischargeSummary> => {
    const cols: Partial<DischargeSummary> = {};
    const has = (key: keyof DischargeSummaryInput) => !partial || key in input;
    if (!partial) {
        if (!input.patientId) throw new Error("patientId is required.");
        if (!input.doctorId) throw new Error("doctorId is required.");
        if (!Number.isInteger(Number(input.hospitalId)) || Number(input.hospitalId) < 1) throw new Error("hospitalId is required.");
        cols.PatientId = input.patientId;
        cols.DoctorId = input.doctorId;
        cols.HospitalId = Number(input.hospitalId);
        cols.OrganizationId = input.organizationId ? Number(input.organizationId) : null;
    }
    if (has("admittedAt")) cols.AdmittedAt = dateTime(input.admittedAt, "admittedAt");
    if (has("dischargedAt")) cols.DischargedAt = dateTime(input.dischargedAt, "dischargedAt");
    for (const [key, column] of Object.entries(LISTS) as Array<[keyof typeof LISTS, (typeof LISTS)[keyof typeof LISTS]]>) {
        if (has(key)) cols[column] = codedList(input[key], key);
    }
    if (has("allergies")) cols.Allergies = optionalText(input.allergies);
    if (has("investigations")) cols.Investigations = optionalText(input.investigations);
    if (has("prescriptionId")) cols.PrescriptionId = optionalText(input.prescriptionId);
    if (has("carePlan")) cols.CarePlan = optionalText(input.carePlan);
    if (has("followUpDate")) cols.FollowUpDate = input.followUpDate ? dateTime(input.followUpDate, "followUpDate") : null;
    if (has("disposition")) cols.Disposition = optionalText(input.disposition);
    if (has("documentId")) cols.DocumentId = input.documentId ? Number(input.documentId) : null;
    if (has("status")) {
        const status = input.status ?? "Draft";
        if (status !== "Draft" && status !== "Final") throw new Error("status must be Draft or Final.");
        cols.Status = status;
    }
    return cols;
};

const parseCoded = (json?: string | null): CodedTextInput[] => {
    if (!json) return [];
    try {
        const items = JSON.parse(json);
        return Array.isArray(items) ? items : [];
    } catch {
        return [];
    }
};

/** A row as the API returns it: the coded lists as arrays rather than the JSON they are stored as. */
export type DischargeSummaryView = Omit<DischargeSummary, (typeof LISTS)[keyof typeof LISTS]> & {
    [K in (typeof LISTS)[keyof typeof LISTS]]: CodedTextInput[];
};

export const toView = (row: DischargeSummary): DischargeSummaryView => ({
    ...row,
    ChiefComplaints: parseCoded(row.ChiefComplaints),
    Diagnoses: parseCoded(row.Diagnoses),
    MedicalHistory: parseCoded(row.MedicalHistory),
    ExaminationFindings: parseCoded(row.ExaminationFindings),
    Procedures: parseCoded(row.Procedures),
});

/** Room for a desk clock running a little ahead of the server's. */
const FUTURE_SLACK_MS = 5 * 60_000;

/**
 * Admission comes before discharge, and a Final summary records a discharge that has happened, so
 * it is not dated in the future: ABDM shares a record only inside the consented date range, which
 * ends when the patient consents, so a future-dated one would never reach them.
 */
export const checkDates = (s: Pick<DischargeSummary, "AdmittedAt" | "DischargedAt" | "Status">, now: Date) => {
    if (s.DischargedAt < s.AdmittedAt) throw new Error("dischargedAt can't be before admittedAt.");
    if (s.Status === "Final" && s.DischargedAt.getTime() > now.getTime() + FUTURE_SLACK_MS) {
        throw new Error("A Final discharge summary can't have a discharge date in the future. Correct the date, or keep it as a Draft until the patient is discharged.");
    }
};

export class DischargeSummaryService {
    constructor(private readonly now: () => Date = () => new Date()) {}

    private get repository() {
        return AppDataSource.getRepository(DischargeSummary);
    }

    async create(input: DischargeSummaryInput, createdBy?: string): Promise<DischargeSummaryView> {
        const cols = dischargeSummaryColumns(input);
        checkDates(cols as DischargeSummary, this.now());
        return toView(await this.repository.save(this.repository.create({ ...cols, CreatedBy: createdBy ?? null })));
    }

    private async row(id: number): Promise<DischargeSummary | null> {
        return this.repository.findOne({ where: { Id: id, IsDeleted: false } });
    }

    async get(id: number): Promise<DischargeSummaryView | null> {
        const row = await this.row(id);
        return row ? toView(row) : null;
    }

    async listForPatient(patientId: string, hospitalId?: number): Promise<DischargeSummaryView[]> {
        const rows = await this.repository.find({
            where: { PatientId: patientId, IsDeleted: false, ...(hospitalId ? { HospitalId: hospitalId } : {}) },
            order: { DischargedAt: "DESC" },
        });
        return rows.map(toView);
    }

    async update(id: number, input: Partial<DischargeSummaryInput>, updatedBy?: string): Promise<DischargeSummaryView> {
        const existing = await this.row(id);
        if (!existing) throw new Error("Discharge summary not found.");
        const cols = dischargeSummaryColumns(input, true);
        checkDates({ ...existing, ...cols }, this.now());
        // The row's own patient and hospital ride along so the ABDM auto-linker sees whose summary changed (a Draft made Final)
        await this.repository.update(id, { PatientId: existing.PatientId, HospitalId: existing.HospitalId, ...cols, UpdatedAt: new Date(), UpdatedBy: updatedBy ?? null });
        return (await this.get(id))!;
    }

    async delete(id: number, updatedBy?: string): Promise<void> {
        await this.repository.update(id, { IsDeleted: true, UpdatedAt: new Date(), UpdatedBy: updatedBy ?? null });
    }
}

export const dischargeSummaryService = new DischargeSummaryService();
