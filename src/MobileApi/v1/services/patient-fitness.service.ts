import { AppDataSource } from "../../../config/database.js";
import { PatientFitnessData } from "../../../models/Fitness/patient-fitness.model.js";
import {
    MAX_HOURLY_JSON_LENGTH,
    MAX_METRICS_JSON_LENGTH,
    addDays,
    boundedJson,
    isCalendarDate,
    isDuplicateKeyError,
    isSyncableDate,
    localDateKey,
} from "../../../services/Fitness/fitness-input.js";

export interface FitnessRecordInput {
    date: string; // YYYY-MM-DD
    steps?: number | null;
    calories?: number | null;
    distanceMeters?: number | null;
    activeMinutes?: number | null;
    flightsClimbed?: number | null;
    heartRateAvg?: number | null;
    heartRateMin?: number | null;
    heartRateMax?: number | null;
    restingHeartRate?: number | null;
    bloodOxygen?: number | null;
    bloodPressureSys?: number | null;
    bloodPressureDia?: number | null;
    sleepMinutes?: number | null;
    sleepDeepMinutes?: number | null;
    sleepRemMinutes?: number | null;
    sleepLightMinutes?: number | null;
    sleepAwakeMinutes?: number | null;
    weightKg?: number | null;
    bmi?: number | null;
    waterLiters?: number | null;
    bloodGlucoseMgDl?: number | null;
    source?: string;
    rawHourlyJson?: any;
    rawMetricsJson?: any;
}

export interface FitnessSyncOptions {
    /**
     * 2 = the app reads aggregated, de-duplicated daily totals and sends null
     * for anything it has no reading for. Older builds send 0 for missing values
     * and summed raw samples, so their values never replace a positive one.
     */
    schema?: number;
    /** A full re-read of the window: the device's values replace the stored ones, nulls included. */
    repair?: boolean;
}

type FieldSpec = {
    input: keyof FitnessRecordInput;
    column: keyof PatientFitnessData;
    int?: boolean;
    min: number;
    max: number;
};

// Readings outside these ranges are sensor glitches or unit mix-ups, not data.
const FIELDS: FieldSpec[] = [
    { input: "steps", column: "Steps", int: true, min: 0, max: 150000 },
    { input: "calories", column: "Calories", min: 0, max: 20000 },
    { input: "distanceMeters", column: "DistanceMeters", min: 0, max: 300000 },
    { input: "activeMinutes", column: "ActiveMinutes", int: true, min: 0, max: 1440 },
    { input: "flightsClimbed", column: "FlightsClimbed", int: true, min: 0, max: 2000 },
    { input: "heartRateAvg", column: "HeartRateAvg", min: 20, max: 250 },
    { input: "heartRateMin", column: "HeartRateMin", min: 20, max: 250 },
    { input: "heartRateMax", column: "HeartRateMax", min: 20, max: 250 },
    { input: "restingHeartRate", column: "RestingHeartRate", min: 20, max: 200 },
    { input: "bloodOxygen", column: "BloodOxygen", min: 50, max: 100 },
    { input: "bloodPressureSys", column: "BloodPressureSys", min: 50, max: 260 },
    { input: "bloodPressureDia", column: "BloodPressureDia", min: 30, max: 180 },
    { input: "sleepMinutes", column: "SleepMinutes", int: true, min: 0, max: 1440 },
    { input: "sleepDeepMinutes", column: "SleepDeepMinutes", int: true, min: 0, max: 1440 },
    { input: "sleepRemMinutes", column: "SleepRemMinutes", int: true, min: 0, max: 1440 },
    { input: "sleepLightMinutes", column: "SleepLightMinutes", int: true, min: 0, max: 1440 },
    { input: "sleepAwakeMinutes", column: "SleepAwakeMinutes", int: true, min: 0, max: 1440 },
    { input: "weightKg", column: "WeightKg", min: 1, max: 400 },
    { input: "bmi", column: "Bmi", min: 5, max: 100 },
    { input: "waterLiters", column: "WaterLiters", min: 0, max: 20 },
    { input: "bloodGlucoseMgDl", column: "BloodGlucoseMgDl", min: 10, max: 1000 },
];

const MAX_RECORDS = 120;

const toDateKey = (d: any): string => {
    if (!d) return "";
    if (d instanceof Date) return d.toISOString().split("T")[0];
    return String(d).split("T")[0];
};

/** A clean number for one field, or null when the value is missing or implausible. */
function cleanValue(raw: any, spec: FieldSpec): number | null {
    if (raw === undefined || raw === null || raw === "") return null;
    let n = Number(raw);
    if (!Number.isFinite(n)) return null;
    // Older builds sent SpO2 as a 0-1 ratio.
    if (spec.input === "bloodOxygen" && n > 0 && n <= 1) n = n * 100;
    if (n < spec.min || n > spec.max) return null;
    return spec.int ? Math.round(n) : Number(n.toFixed(1));
}

/** Stored values read back as numbers, with nothing recorded as null. Zero counts as nothing. */
const reading = (v: any): number | null => {
    const n = Number(v);
    return v === null || v === undefined || !Number.isFinite(n) || n <= 0 ? null : n;
};

const spo2Reading = (v: any): number | null => {
    const n = reading(v);
    if (n === null) return null;
    return Number((n <= 1 ? n * 100 : n).toFixed(1));
};

const formatSleep = (minutes: number | null) =>
    minutes ? `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m` : "0h 0m";

export class PatientFitnessService {
    private get fitnessRepo() {
        return AppDataSource.getRepository(PatientFitnessData);
    }

    /**
     * Upserts one row per patient and calendar day.
     *
     * Schema 2 values are trusted as the device's daily totals: a number
     * replaces what is stored and a null leaves it alone. A repair sync goes
     * further and clears stored values the device no longer reports, which
     * removes the estimated calories and double-counted steps older builds
     * saved. Days the device sends no reading at all for are left untouched.
     */
    async syncFitnessBatch(
        patientId: string,
        source: string,
        records: FitnessRecordInput[],
        options: FitnessSyncOptions = {},
    ) {
        if (!patientId) throw new Error("patientId is required");
        if (!Array.isArray(records) || records.length === 0) {
            return { success: true, syncedCount: 0, message: "No records provided" };
        }

        const isV2 = Number(options.schema) >= 2;
        const repair = isV2 && options.repair === true;
        const sourceName = typeof source === "string" ? source.trim().slice(0, 50) : "";

        // One row per date; a later entry for the same date wins. Impossible
        // dates (2026-02-30, or years ahead from a wrong phone clock) are dropped
        // here instead of failing the whole batch in SQL.
        const today = localDateKey();
        const byDate = new Map<string, FitnessRecordInput>();
        let rejected = 0;
        for (const item of records.slice(0, MAX_RECORDS)) {
            const key = toDateKey(item?.date);
            if (isSyncableDate(key, today)) byDate.set(key, item);
            else rejected++;
        }
        if (byDate.size === 0) {
            return { success: true, syncedCount: 0, rejectedCount: rejected, message: "No valid records provided" };
        }

        // Two syncs for the same new day can race; the loser re-reads and updates.
        try {
            return { ...(await this.upsertDays(patientId, sourceName, byDate, isV2, repair)), rejectedCount: rejected };
        } catch (error) {
            if (!isDuplicateKeyError(error)) throw error;
            return { ...(await this.upsertDays(patientId, sourceName, byDate, isV2, repair)), rejectedCount: rejected };
        }
    }

    private async upsertDays(
        patientId: string,
        source: string,
        byDate: Map<string, FitnessRecordInput>,
        isV2: boolean,
        repair: boolean,
    ) {
        const dates = [...byDate.keys()].sort();
        const existingRows = await this.fitnessRepo
            .createQueryBuilder("f")
            .where("f.PatientId = :patientId", { patientId })
            .andWhere("f.Date BETWEEN :from AND :to", { from: dates[0], to: dates[dates.length - 1] })
            .getMany();
        const existingByDate = new Map(existingRows.map(r => [toDateKey(r.Date), r]));

        const toSave: PatientFitnessData[] = [];
        let skipped = 0;

        for (const dateKey of dates) {
            const item = byDate.get(dateKey)!;
            const values = new Map<FieldSpec, number | null>();
            for (const spec of FIELDS) values.set(spec, cleanValue(item[spec.input], spec));

            const hasAnyReading = [...values.values()].some(v => v !== null && v > 0);
            let row = existingByDate.get(dateKey);
            const hourly = boundedJson(item.rawHourlyJson, MAX_HOURLY_JSON_LENGTH, { array: true });
            const metrics = boundedJson(item.rawMetricsJson, MAX_METRICS_JSON_LENGTH);

            if (!hasAnyReading && !hourly) {
                skipped++;
                continue;
            }

            if (!row) {
                const itemSource = typeof item.source === "string" ? item.source.trim() : "";
                row = this.fitnessRepo.create({
                    PatientId: patientId,
                    Date: dateKey,
                    Source: (source || itemSource || "Unknown").slice(0, 50),
                    CreatedAt: new Date(),
                });
                // Columns default to 0 in the database; start from "no reading" instead.
                for (const spec of FIELDS) (row as any)[spec.column] = null;
            } else {
                row.UpdatedAt = new Date();
                if (source) row.Source = source.slice(0, 50);
            }

            for (const spec of FIELDS) {
                const next = values.get(spec)!;
                const current = (row as any)[spec.column];
                if (isV2) {
                    if (next !== null) (row as any)[spec.column] = next;
                    else if (repair) (row as any)[spec.column] = null;
                } else if (next !== null && (next > 0 || !current)) {
                    // Older builds send 0 for "no data", so a 0 never replaces a reading.
                    (row as any)[spec.column] = next;
                }
            }

            if (hourly) {
                row.RawHourlyJson = hourly;
            } else if (repair) {
                row.RawHourlyJson = null as any;
            }
            if (metrics) row.RawMetricsJson = metrics;
            toSave.push(row);
        }

        if (toSave.length) await this.fitnessRepo.save(toSave, { chunk: 30 });

        return {
            success: true,
            syncedCount: toSave.length,
            skippedCount: skipped,
            syncedAt: new Date().toISOString(),
            message: `Synced ${toSave.length} day${toSave.length === 1 ? "" : "s"} of fitness data`,
        };
    }

    /**
     * Daily points for a calendar window ending on the client's today, with a
     * point for every day (null values where nothing was recorded), averages
     * over the days that have readings, and the latest weight and SpO2.
     */
    async getFitnessSummary(patientId: string, period: "day" | "week" | "month" = "week", todayDate?: string) {
        if (!patientId) throw new Error("patientId is required");

        const days = period === "day" ? 1 : period === "week" ? 7 : 30;
        // The client's own date when it sends one. The fallback is India's date:
        // the UTC date is still yesterday until 5:30 in the morning here.
        const today = isCalendarDate(todayDate) ? todayDate : localDateKey();
        const from = addDays(today, -(days - 1));
        // The previous window of the same length, for "vs last week" comparisons.
        const previousFrom = addDays(from, -days);

        const rows = await this.fitnessRepo
            .createQueryBuilder("f")
            .where("f.PatientId = :patientId", { patientId })
            .andWhere("f.Date BETWEEN :from AND :to", { from: previousFrom, to: today })
            .orderBy("f.Date", "ASC")
            .getMany();
        const byDate = new Map(rows.map(r => [toDateKey(r.Date), r]));

        const pointFor = (dateKey: string) => {
            const r = byDate.get(dateKey);
            let hourly: any[] = [];
            if (r?.RawHourlyJson) {
                try {
                    const parsed = JSON.parse(r.RawHourlyJson);
                    if (Array.isArray(parsed)) hourly = parsed;
                } catch (_) {}
            }
            return {
                date: dateKey,
                hasData: !!r,
                steps: reading(r?.Steps),
                calories: reading(r?.Calories),
                distanceMeters: reading(r?.DistanceMeters),
                heartRateAvg: reading(r?.HeartRateAvg),
                heartRateMin: reading(r?.HeartRateMin),
                heartRateMax: reading(r?.HeartRateMax),
                restingHeartRate: reading(r?.RestingHeartRate),
                bloodOxygen: spo2Reading(r?.BloodOxygen),
                sleepMinutes: reading(r?.SleepMinutes),
                sleepDeepMinutes: reading(r?.SleepDeepMinutes),
                sleepRemMinutes: reading(r?.SleepRemMinutes),
                sleepLightMinutes: reading(r?.SleepLightMinutes),
                sleepAwakeMinutes: reading(r?.SleepAwakeMinutes),
                weightKg: reading(r?.WeightKg),
                hourly,
            };
        };

        const chartPoints: ReturnType<typeof pointFor>[] = [];
        for (let i = 0; i < days; i++) chartPoints.push(pointFor(addDays(from, i)));
        const previousPoints: ReturnType<typeof pointFor>[] = [];
        for (let i = 0; i < days; i++) previousPoints.push(pointFor(addDays(previousFrom, i)));

        const present = (arr: (number | null)[]) => arr.filter((v): v is number => v !== null);
        const avg = (arr: number[]) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
        const sum = (arr: number[]) => Math.round(arr.reduce((a, b) => a + b, 0));
        const max = (arr: number[]) => (arr.length ? Math.max(...arr) : 0);
        const min = (arr: number[]) => (arr.length ? Math.min(...arr) : 0);

        const steps = present(chartPoints.map(p => p.steps));
        const cals = present(chartPoints.map(p => p.calories));
        const hr = present(chartPoints.map(p => p.heartRateAvg));
        const resting = present(chartPoints.map(p => p.restingHeartRate));
        const sleep = present(chartPoints.map(p => p.sleepMinutes));
        const distance = present(chartPoints.map(p => p.distanceMeters));

        const analytics = {
            steps: { average: avg(steps), peak: max(steps), lowest: min(steps), total: sum(steps), count: steps.length },
            calories: { average: avg(cals), peak: max(cals), lowest: min(cals), total: sum(cals) },
            distance: { average: avg(distance), total: sum(distance) },
            heartRate: {
                average: avg(hr),
                peak: max(present(chartPoints.map(p => p.heartRateMax))),
                lowest: min(present(chartPoints.map(p => p.heartRateMin))),
                restingAverage: avg(resting),
            },
            sleep: {
                averageMinutes: avg(sleep),
                totalMinutes: sum(sleep),
                averageHoursFormatted: formatSleep(avg(sleep)),
                nights: sleep.length,
            },
            previous: {
                stepsAverage: avg(present(previousPoints.map(p => p.steps))),
                sleepAverageMinutes: avg(present(previousPoints.map(p => p.sleepMinutes))),
                restingHeartRateAverage: avg(present(previousPoints.map(p => p.restingHeartRate))),
            },
            daysWithData: chartPoints.filter(p => p.hasData).length,
        };

        // Weight and SpO2 are measured now and then, so show the most recent reading.
        const latest = await this.fitnessRepo
            .createQueryBuilder("f")
            .select(["f.Date", "f.WeightKg", "f.BloodOxygen", "f.UpdatedAt", "f.CreatedAt", "f.Source"])
            .where("f.PatientId = :patientId", { patientId })
            .andWhere("f.Date <= :today", { today })
            .orderBy("f.Date", "DESC")
            .take(120)
            .getMany();
        const latestWeight = latest.find(r => reading(r.WeightKg) !== null);
        const latestSpo2 = latest.find(r => spo2Reading(r.BloodOxygen) !== null);
        const lastSyncedAt = latest.reduce<Date | null>((acc, r) => {
            const t = r.UpdatedAt || r.CreatedAt;
            return t && (!acc || t > acc) ? t : acc;
        }, null);

        const todayPoint = chartPoints[chartPoints.length - 1];
        const todayRow = byDate.get(today);

        return {
            patientId,
            period,
            from,
            to: today,
            // Only today's own row; an older day is never shown as today.
            today: todayRow
                ? {
                      ...todayPoint,
                      sleepFormatted: formatSleep(todayPoint.sleepMinutes),
                      source: todayRow.Source,
                      lastSynced: todayRow.UpdatedAt || todayRow.CreatedAt,
                  }
                : null,
            latest: {
                weightKg: latestWeight ? reading(latestWeight.WeightKg) : null,
                weightDate: latestWeight ? toDateKey(latestWeight.Date) : null,
                bloodOxygen: latestSpo2 ? spo2Reading(latestSpo2.BloodOxygen) : null,
                bloodOxygenDate: latestSpo2 ? toDateKey(latestSpo2.Date) : null,
            },
            lastSyncedAt,
            source: latest[0]?.Source ?? null,
            analytics,
            chartPoints,
        };
    }

    /**
     * Get patient fitness connection status and latest sync information.
     */
    async getFitnessStatus(patientId: string) {
        if (!patientId) throw new Error("patientId is required");

        const latest = await this.fitnessRepo.findOne({
            where: { PatientId: patientId },
            order: { Date: "DESC", CreatedAt: "DESC" }
        }).catch(() => null);

        return {
            isConnected: !!latest,
            source: latest?.Source || null,
            lastSyncedAt: latest?.UpdatedAt || latest?.CreatedAt || null,
            latestRecord: latest ? {
                date: toDateKey(latest.Date),
                steps: reading(latest.Steps),
                calories: reading(latest.Calories),
                heartRate: reading(latest.HeartRateAvg),
                sleepMinutes: reading(latest.SleepMinutes)
            } : null
        };
    }
}

export const patientFitnessService = new PatientFitnessService();
