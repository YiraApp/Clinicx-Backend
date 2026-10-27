import { AppDataSource } from "../../config/database.js";
import { PatientDiagnosticReport } from "../../models/Appointments/diagnostic-report.model.js";
import { codedList, type CodedTextInput } from "./discharge-summary.service.js";

/** Lab and imaging reports entered at the clinic, which ABDM shares as a DiagnosticReport once they are Final. */

export type ResultInterpretation = "normal" | "high" | "low" | "abnormal";

export interface ReportResult {
    name: string;
    conceptId?: string | null;
    value?: number | null;
    valueText?: string | null;
    unit?: string | null;
    low?: number | null;
    high?: number | null;
    referenceText?: string | null;
    interpretation?: ResultInterpretation | null;
}

export interface DiagnosticReportInput {
    patientId: string;
    hospitalId: number;
    organizationId?: number | null;
    appointmentId?: number | null;
    doctorId?: string | null;
    category: "Lab" | "Imaging";
    testName: string;
    testConceptId?: string | null;
    specimenType?: string | null;
    specimenConceptId?: string | null;
    collectedAt?: string | null;
    issuedAt: string;
    performedBy?: string | null;
    results?: ReportResult[];
    conclusion?: string | null;
    conclusionCodes?: CodedTextInput[];
    documentId?: number | null;
    status?: "Draft" | "Final";
}

const CATEGORIES = ["Lab", "Imaging"];
const INTERPRETATIONS: ResultInterpretation[] = ["normal", "high", "low", "abnormal"];
const SNOMED_ID = /^\d{6,18}$/;

const text = (value: unknown, max: number, name: string): string | null => {
    if (value === undefined || value === null || String(value).trim() === "") return null;
    const s = String(value).trim();
    if (s.length > max) throw new Error(`${name} is longer than ${max} characters.`);
    return s;
};
const conceptId = (value: unknown, name: string): string | null => {
    const id = text(value, 20, name);
    if (id && !SNOMED_ID.test(id)) throw new Error(`${name} must be a SNOMED CT concept id.`);
    return id;
};
const number = (value: unknown, name: string): number | null => {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number.`);
    return n;
};
const dateTime = (value: unknown, name: string): Date => {
    const d = new Date(String(value ?? ""));
    if (!value || Number.isNaN(d.getTime())) throw new Error(`${name} must be a date and time.`);
    return d;
};
const positiveInt = (value: unknown, name: string): number | null => {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number of 1 or more.`);
    return n;
};

/** Where a value falls against its range, when the clinician did not say. */
export const interpretationOf = (r: Pick<ReportResult, "value" | "low" | "high">): ResultInterpretation | null => {
    if (r.value === null || r.value === undefined) return null;
    if (r.low !== null && r.low !== undefined && r.value < r.low) return "low";
    if (r.high !== null && r.high !== undefined && r.value > r.high) return "high";
    return (r.low ?? r.high) !== null && (r.low ?? r.high) !== undefined ? "normal" : null;
};

/** The results as stored: JSON, each named, with a number or words, its range checked. */
export const reportResults = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value)) throw new Error("results must be a list.");
    const rows = value.map((r: any, i): ReportResult => {
        const at = `results[${i}]`;
        const name = text(r?.name, 200, `${at}.name`);
        if (!name) throw new Error(`${at} needs the test name.`);
        const row: ReportResult = {
            name,
            conceptId: conceptId(r?.conceptId, `${at}.conceptId`),
            value: number(r?.value, `${at}.value`),
            valueText: text(r?.valueText, 200, `${at}.valueText`),
            unit: text(r?.unit, 40, `${at}.unit`),
            low: number(r?.low, `${at}.low`),
            high: number(r?.high, `${at}.high`),
            referenceText: text(r?.referenceText, 200, `${at}.referenceText`),
            interpretation: null,
        };
        if (row.value === null && !row.valueText) throw new Error(`${at} (${name}) needs a value or a text result.`);
        if (row.low !== null && row.high !== null && row.low! > row.high!) throw new Error(`${at} (${name}): the range low is above its high.`);
        const given = r?.interpretation ? String(r.interpretation).toLowerCase() : null;
        if (given && !INTERPRETATIONS.includes(given as ResultInterpretation)) throw new Error(`${at}.interpretation must be normal, high, low or abnormal.`);
        row.interpretation = (given as ResultInterpretation | null) ?? interpretationOf(row);
        // Kept compact: an empty field is left out of the stored row
        return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined)) as unknown as ReportResult;
    });
    return rows.length ? JSON.stringify(rows) : null;
};

/** The columns an input sets, checked. [partial] skips what an update leaves out. */
export const diagnosticReportColumns = (input: Partial<DiagnosticReportInput>, partial = false): Partial<PatientDiagnosticReport> => {
    const cols: Partial<PatientDiagnosticReport> = {};
    const has = (key: keyof DiagnosticReportInput) => !partial || key in input;
    if (!partial) {
        if (!input.patientId) throw new Error("patientId is required.");
        if (!positiveInt(input.hospitalId, "hospitalId")) throw new Error("hospitalId is required.");
        cols.PatientId = input.patientId;
        cols.HospitalId = Number(input.hospitalId);
        cols.OrganizationId = positiveInt(input.organizationId, "organizationId");
        cols.AppointmentId = positiveInt(input.appointmentId, "appointmentId");
    }
    if (has("doctorId")) cols.DoctorId = text(input.doctorId, 36, "doctorId");
    if (has("category")) {
        if (!CATEGORIES.includes(String(input.category))) throw new Error("category must be Lab or Imaging.");
        cols.Category = String(input.category);
    }
    if (has("testName")) {
        const name = text(input.testName, 200, "testName");
        if (!name) throw new Error("testName is required.");
        cols.TestName = name;
    }
    if (has("testConceptId")) {
        // A LOINC code from the common tests list, or a SNOMED CT concept from the picker
        const code = text(input.testConceptId, 20, "testConceptId");
        if (code && !SNOMED_ID.test(code) && !/^\d{1,7}-\d$/.test(code)) throw new Error("testConceptId must be a LOINC code or a SNOMED CT concept id.");
        cols.TestConceptId = code;
    }
    if (has("specimenType")) cols.SpecimenType = text(input.specimenType, 100, "specimenType");
    if (has("specimenConceptId")) cols.SpecimenConceptId = conceptId(input.specimenConceptId, "specimenConceptId");
    if (has("collectedAt")) cols.CollectedAt = input.collectedAt ? dateTime(input.collectedAt, "collectedAt") : null;
    if (has("issuedAt")) cols.IssuedAt = dateTime(input.issuedAt, "issuedAt");
    if (has("performedBy")) cols.PerformedBy = text(input.performedBy, 200, "performedBy");
    if (has("results")) cols.Results = reportResults(input.results);
    if (has("conclusion")) cols.Conclusion = text(input.conclusion, 8000, "conclusion");
    if (has("conclusionCodes")) cols.ConclusionCodes = codedList(input.conclusionCodes, "conclusionCodes");
    if (has("documentId")) cols.DocumentId = positiveInt(input.documentId, "documentId");
    if (has("status")) {
        const status = input.status ?? "Draft";
        if (status !== "Draft" && status !== "Final") throw new Error("status must be Draft or Final.");
        cols.Status = status;
    }
    return cols;
};

/** Room for a desk clock running a little ahead of the server's. */
const FUTURE_SLACK_MS = 5 * 60_000;

/**
 * A specimen is collected before its report is issued. A Final report is one that exists, so it is
 * not dated in the future (ABDM shares only inside the consented range, which ends at consent), and
 * it holds what NRCES's profiles require: a lab report its results and a conclusion, an imaging
 * report a conclusion and the image.
 */
export const checkReport = (r: Partial<PatientDiagnosticReport>, now: Date) => {
    if (r.CollectedAt && r.IssuedAt && r.CollectedAt > r.IssuedAt) throw new Error("collectedAt can't be after issuedAt.");
    if (r.Status !== "Final") return;
    if (r.IssuedAt && r.IssuedAt.getTime() > now.getTime() + FUTURE_SLACK_MS) {
        throw new Error("A Final report can't be issued in the future. Correct the date, or keep it as a Draft until it is issued.");
    }
    if (!r.Conclusion?.trim()) throw new Error("A Final report needs a conclusion / impression.");
    if (r.Category === "Lab" && !r.Results) throw new Error("A Final lab report needs at least one result.");
    if (r.Category === "Imaging" && !r.DocumentId) throw new Error("A Final imaging report needs the image or scan report attached.");
};

const parseList = <T>(json?: string | null): T[] => {
    if (!json) return [];
    try {
        const items = JSON.parse(json);
        return Array.isArray(items) ? items : [];
    } catch {
        return [];
    }
};

export type DiagnosticReportView = Omit<PatientDiagnosticReport, "Results" | "ConclusionCodes"> & { Results: ReportResult[]; ConclusionCodes: CodedTextInput[] };

export const toReportView = (row: PatientDiagnosticReport): DiagnosticReportView => ({
    ...row,
    Results: parseList<ReportResult>(row.Results),
    ConclusionCodes: parseList<CodedTextInput>(row.ConclusionCodes),
});

export class DiagnosticReportService {
    constructor(private readonly now: () => Date = () => new Date()) {}

    private get repository() {
        return AppDataSource.getRepository(PatientDiagnosticReport);
    }

    private async row(id: number): Promise<PatientDiagnosticReport | null> {
        return this.repository.findOne({ where: { Id: id, IsDeleted: false } });
    }

    async create(input: DiagnosticReportInput, createdBy?: string): Promise<DiagnosticReportView> {
        const cols = diagnosticReportColumns(input);
        checkReport({ Status: "Draft", ...cols }, this.now());
        return toReportView(await this.repository.save(this.repository.create({ ...cols, CreatedBy: createdBy ?? null })));
    }

    async get(id: number): Promise<DiagnosticReportView | null> {
        const row = await this.row(id);
        return row ? toReportView(row) : null;
    }

    async listForPatient(patientId: string, hospitalId?: number): Promise<DiagnosticReportView[]> {
        const rows = await this.repository.find({
            where: { PatientId: patientId, IsDeleted: false, ...(hospitalId ? { HospitalId: hospitalId } : {}) },
            order: { IssuedAt: "DESC" },
        });
        return rows.map(toReportView);
    }

    async update(id: number, input: Partial<DiagnosticReportInput>, updatedBy?: string): Promise<DiagnosticReportView> {
        const existing = await this.row(id);
        if (!existing) throw new Error("Diagnostic report not found.");
        const cols = diagnosticReportColumns(input, true);
        checkReport({ ...existing, ...cols }, this.now());
        // The row's own patient, hospital and visit ride along so the ABDM auto-linker sees whose report changed
        await this.repository.update(id, {
            PatientId: existing.PatientId, HospitalId: existing.HospitalId, AppointmentId: existing.AppointmentId ?? null,
            ...cols, UpdatedAt: new Date(), UpdatedBy: updatedBy ?? null,
        });
        return (await this.get(id))!;
    }

    async delete(id: number, updatedBy?: string): Promise<void> {
        await this.repository.update(id, { IsDeleted: true, UpdatedAt: new Date(), UpdatedBy: updatedBy ?? null });
    }
}

export const diagnosticReportService = new DiagnosticReportService();
