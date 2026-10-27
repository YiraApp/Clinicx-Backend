import { AppDataSource } from "../../config/database.js";
import { WellnessRecord } from "../../models/Appointments/wellness-record.model.js";

/** Wellness checks recorded at the clinic, which ABDM shares as a WellnessRecord. */

export interface WellnessRecordInput {
    patientId: string;
    hospitalId: number;
    organizationId?: number | null;
    appointmentId?: number | null;
    recordedAt: string;
    systolic?: number | null;
    diastolic?: number | null;
    heartRate?: number | null;
    respiratoryRate?: number | null;
    temperatureC?: number | null;
    spo2?: number | null;
    heightCm?: number | null;
    weightKg?: number | null;
    steps?: number | null;
    caloriesBurned?: number | null;
    sleepHours?: number | null;
    bloodGlucose?: number | null;
    fluidIntakeLitres?: number | null;
    notes?: string | null;
}

type Measure = Exclude<keyof WellnessRecordInput, "patientId" | "hospitalId" | "organizationId" | "appointmentId" | "recordedAt" | "notes">;

/** Each measurement: its column, whether it is a whole number, and the range a person's value can fall in. */
const MEASURES: Record<Measure, { column: keyof WellnessRecord; whole: boolean; min: number; max: number; label: string }> = {
    systolic: { column: "Systolic", whole: true, min: 40, max: 300, label: "Systolic blood pressure (mmHg)" },
    diastolic: { column: "Diastolic", whole: true, min: 20, max: 200, label: "Diastolic blood pressure (mmHg)" },
    heartRate: { column: "HeartRate", whole: true, min: 20, max: 300, label: "Pulse (/min)" },
    respiratoryRate: { column: "RespiratoryRate", whole: true, min: 4, max: 80, label: "Respiratory rate (/min)" },
    temperatureC: { column: "TemperatureC", whole: false, min: 25, max: 45, label: "Temperature (°C)" },
    spo2: { column: "SpO2", whole: true, min: 50, max: 100, label: "SpO2 (%)" },
    heightCm: { column: "HeightCm", whole: false, min: 30, max: 250, label: "Height (cm)" },
    weightKg: { column: "WeightKg", whole: false, min: 0.5, max: 400, label: "Weight (kg)" },
    steps: { column: "Steps", whole: true, min: 0, max: 200000, label: "Steps" },
    caloriesBurned: { column: "CaloriesBurned", whole: true, min: 0, max: 20000, label: "Calories burned (kcal)" },
    sleepHours: { column: "SleepHours", whole: false, min: 0, max: 24, label: "Sleep (hours)" },
    bloodGlucose: { column: "BloodGlucose", whole: false, min: 10, max: 1000, label: "Blood glucose (mg/dL)" },
    fluidIntakeLitres: { column: "FluidIntakeLitres", whole: false, min: 0, max: 20, label: "Fluid intake (L)" },
};

const positiveInt = (value: unknown, name: string): number | null => {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number of 1 or more.`);
    return n;
};

const measurement = (value: unknown, m: (typeof MEASURES)[Measure]): number | null => {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${m.label} must be a number.`);
    if (m.whole && !Number.isInteger(n)) throw new Error(`${m.label} must be a whole number.`);
    if (n < m.min || n > m.max) throw new Error(`${m.label} must be between ${m.min} and ${m.max}.`);
    return m.whole ? n : Math.round(n * 10) / 10;
};

/** The columns an input sets, checked. [partial] skips what an update leaves out. */
export const wellnessColumns = (input: Partial<WellnessRecordInput>, partial = false): Partial<WellnessRecord> => {
    const cols: Partial<WellnessRecord> = {};
    const has = (key: keyof WellnessRecordInput) => !partial || key in input;
    if (!partial) {
        if (!input.patientId) throw new Error("patientId is required.");
        if (!positiveInt(input.hospitalId, "hospitalId")) throw new Error("hospitalId is required.");
        cols.PatientId = input.patientId;
        cols.HospitalId = Number(input.hospitalId);
        cols.OrganizationId = positiveInt(input.organizationId, "organizationId");
        cols.AppointmentId = positiveInt(input.appointmentId, "appointmentId");
    }
    if (has("recordedAt")) {
        const d = new Date(String(input.recordedAt ?? ""));
        if (!input.recordedAt || Number.isNaN(d.getTime())) throw new Error("recordedAt must be a date and time.");
        cols.RecordedAt = d;
    }
    for (const [key, m] of Object.entries(MEASURES) as Array<[Measure, (typeof MEASURES)[Measure]]>) {
        if (has(key)) (cols as any)[m.column] = measurement(input[key], m);
    }
    if (has("notes")) {
        const notes = input.notes === undefined || input.notes === null ? "" : String(input.notes).trim();
        if (notes.length > 1000) throw new Error("notes is longer than 1000 characters.");
        cols.Notes = notes || null;
    }
    return cols;
};

/** Room for a desk clock running a little ahead of the server's. */
const FUTURE_SLACK_MS = 5 * 60_000;

/** A wellness record measures something, blood pressure as a pair, at a time that has come. */
export const checkWellness = (r: Partial<WellnessRecord>, now: Date) => {
    if ((r.Systolic == null) !== (r.Diastolic == null)) throw new Error("Blood pressure needs both systolic and diastolic.");
    if (r.Systolic != null && r.Diastolic != null && r.Diastolic >= r.Systolic) throw new Error("Diastolic blood pressure must be below systolic.");
    if (!Object.values(MEASURES).some((m) => r[m.column] !== null && r[m.column] !== undefined)) {
        throw new Error("Record at least one measurement.");
    }
    if (r.RecordedAt && r.RecordedAt.getTime() > now.getTime() + FUTURE_SLACK_MS) throw new Error("recordedAt can't be in the future.");
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Body mass index from height and weight, to one decimal; null without both. */
export const bmiOf = (heightCm?: number | null, weightKg?: number | null): number | null => {
    const h = num(heightCm), w = num(weightKg);
    return h && w ? Math.round((w / (h / 100) ** 2) * 10) / 10 : null;
};

export type WellnessRecordView = WellnessRecord & { Bmi: number | null };

/** A row as the API returns it: decimals as numbers, BMI worked out. */
export const toWellnessView = (row: WellnessRecord): WellnessRecordView => ({
    ...row,
    TemperatureC: num(row.TemperatureC), HeightCm: num(row.HeightCm), WeightKg: num(row.WeightKg),
    SleepHours: num(row.SleepHours), BloodGlucose: num(row.BloodGlucose), FluidIntakeLitres: num(row.FluidIntakeLitres),
    Bmi: bmiOf(row.HeightCm, row.WeightKg),
});

export class WellnessRecordService {
    constructor(private readonly now: () => Date = () => new Date()) {}

    private get repository() {
        return AppDataSource.getRepository(WellnessRecord);
    }

    async create(input: WellnessRecordInput, createdBy?: string): Promise<WellnessRecordView> {
        const cols = wellnessColumns(input);
        checkWellness(cols, this.now());
        return toWellnessView(await this.repository.save(this.repository.create({ ...cols, RecordedById: createdBy ?? null, CreatedBy: createdBy ?? null })));
    }

    async listForPatient(patientId: string, hospitalId?: number): Promise<WellnessRecordView[]> {
        const rows = await this.repository.find({
            where: { PatientId: patientId, IsDeleted: false, ...(hospitalId ? { HospitalId: hospitalId } : {}) },
            order: { RecordedAt: "DESC" },
        });
        return rows.map(toWellnessView);
    }

    async update(id: number, input: Partial<WellnessRecordInput>, updatedBy?: string): Promise<WellnessRecordView> {
        const existing = await this.repository.findOne({ where: { Id: id, IsDeleted: false } });
        if (!existing) throw new Error("Wellness record not found.");
        const cols = wellnessColumns(input, true);
        checkWellness({ ...existing, ...cols }, this.now());
        // The row's own patient, hospital and visit ride along so the ABDM auto-linker sees whose record changed
        await this.repository.update(id, {
            PatientId: existing.PatientId, HospitalId: existing.HospitalId, AppointmentId: existing.AppointmentId ?? null,
            ...cols, UpdatedAt: new Date(), UpdatedBy: updatedBy ?? null,
        });
        return toWellnessView((await this.repository.findOne({ where: { Id: id } }))!);
    }

    async delete(id: number, updatedBy?: string): Promise<void> {
        await this.repository.update(id, { IsDeleted: true, UpdatedAt: new Date(), UpdatedBy: updatedBy ?? null });
    }
}

export const wellnessRecordService = new WellnessRecordService();
