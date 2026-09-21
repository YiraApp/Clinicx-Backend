import { AppDataSource } from "../../../config/database.js";
import { PatientFitnessData } from "../../../models/Fitness/patient-fitness.model.js";

export interface FitnessRecordInput {
    date: string; // YYYY-MM-DD
    steps?: number;
    calories?: number;
    distanceMeters?: number;
    activeMinutes?: number;
    flightsClimbed?: number;
    heartRateAvg?: number;
    heartRateMin?: number;
    heartRateMax?: number;
    restingHeartRate?: number;
    bloodOxygen?: number;
    bloodPressureSys?: number;
    bloodPressureDia?: number;
    sleepMinutes?: number;
    sleepDeepMinutes?: number;
    sleepRemMinutes?: number;
    sleepLightMinutes?: number;
    sleepAwakeMinutes?: number;
    weightKg?: number;
    bmi?: number;
    waterLiters?: number;
    bloodGlucoseMgDl?: number;
    source?: string;
    rawHourlyJson?: any;
    rawMetricsJson?: any;
}

export class PatientFitnessService {
    private get fitnessRepo() {
        return AppDataSource.getRepository(PatientFitnessData);
    }

    /**
     * Batch upsert fitness records for a given patient.
     */
    async syncFitnessBatch(patientId: string, source: string, records: FitnessRecordInput[]) {
        if (!patientId) throw new Error("patientId is required");
        if (!records || !Array.isArray(records) || records.length === 0) {
            return { syncedCount: 0, message: "No records provided" };
        }

        const synced: PatientFitnessData[] = [];

        for (const item of records) {
            if (!item.date) continue;
            const dateStr = item.date.split("T")[0]; // ensure YYYY-MM-DD

            let existing = await this.fitnessRepo
                .createQueryBuilder("f")
                .where("f.PatientId = :patientId AND CAST(f.Date AS DATE) = CAST(:dateStr AS DATE)", {
                    patientId,
                    dateStr
                })
                .getOne()
                .catch(() => null);

            if (!existing) {
                existing = this.fitnessRepo.create({
                    PatientId: patientId,
                    Date: dateStr,
                    Source: source || item.source || "Unknown",
                    CreatedAt: new Date()
                });
            } else {
                existing.UpdatedAt = new Date();
                if (source) existing.Source = source;
            }

            // Assign numerical fields with positive fallback preservation
            if (item.steps !== undefined && item.steps !== null && (Number(item.steps) > 0 || !existing.Steps)) existing.Steps = Math.round(Number(item.steps));
            if (item.calories !== undefined && item.calories !== null && (Number(item.calories) > 0 || !existing.Calories)) existing.Calories = Number(item.calories);
            if (item.distanceMeters !== undefined && item.distanceMeters !== null && (Number(item.distanceMeters) > 0 || !existing.DistanceMeters)) existing.DistanceMeters = Number(item.distanceMeters);
            if (item.activeMinutes !== undefined && item.activeMinutes !== null && (Number(item.activeMinutes) > 0 || !existing.ActiveMinutes)) existing.ActiveMinutes = Math.round(Number(item.activeMinutes));
            if (item.flightsClimbed !== undefined && item.flightsClimbed !== null && (Number(item.flightsClimbed) > 0 || !existing.FlightsClimbed)) existing.FlightsClimbed = Math.round(Number(item.flightsClimbed));

            if (item.heartRateAvg !== undefined && item.heartRateAvg !== null && (Number(item.heartRateAvg) > 0 || !existing.HeartRateAvg)) existing.HeartRateAvg = Number(item.heartRateAvg);
            if (item.heartRateMin !== undefined && item.heartRateMin !== null && (Number(item.heartRateMin) > 0 || !existing.HeartRateMin)) existing.HeartRateMin = Number(item.heartRateMin);
            if (item.heartRateMax !== undefined && item.heartRateMax !== null && (Number(item.heartRateMax) > 0 || !existing.HeartRateMax)) existing.HeartRateMax = Number(item.heartRateMax);
            if (item.restingHeartRate !== undefined && item.restingHeartRate !== null && (Number(item.restingHeartRate) > 0 || !existing.RestingHeartRate)) existing.RestingHeartRate = Number(item.restingHeartRate);

            // Blood oxygen (SpO2): if value is a fractional ratio (<= 1.0, e.g. 0.99), normalize to percentage (99.0)
            if (item.bloodOxygen !== undefined && item.bloodOxygen !== null) {
                let spo2 = Number(item.bloodOxygen);
                if (spo2 > 0 && spo2 <= 1.0) spo2 = spo2 * 100.0;
                if (spo2 > 0 || !existing.BloodOxygen) existing.BloodOxygen = Number(spo2.toFixed(1));
            }
            if (item.bloodPressureSys !== undefined && item.bloodPressureSys !== null && (Number(item.bloodPressureSys) > 0 || !existing.BloodPressureSys)) existing.BloodPressureSys = Number(item.bloodPressureSys);
            if (item.bloodPressureDia !== undefined && item.bloodPressureDia !== null && (Number(item.bloodPressureDia) > 0 || !existing.BloodPressureDia)) existing.BloodPressureDia = Number(item.bloodPressureDia);

            if (item.sleepMinutes !== undefined && item.sleepMinutes !== null && (Number(item.sleepMinutes) > 0 || !existing.SleepMinutes)) existing.SleepMinutes = Math.round(Number(item.sleepMinutes));
            if (item.sleepDeepMinutes !== undefined && item.sleepDeepMinutes !== null && (Number(item.sleepDeepMinutes) > 0 || !existing.SleepDeepMinutes)) existing.SleepDeepMinutes = Math.round(Number(item.sleepDeepMinutes));
            if (item.sleepRemMinutes !== undefined && item.sleepRemMinutes !== null && (Number(item.sleepRemMinutes) > 0 || !existing.SleepRemMinutes)) existing.SleepRemMinutes = Math.round(Number(item.sleepRemMinutes));
            if (item.sleepLightMinutes !== undefined && item.sleepLightMinutes !== null && (Number(item.sleepLightMinutes) > 0 || !existing.SleepLightMinutes)) existing.SleepLightMinutes = Math.round(Number(item.sleepLightMinutes));
            if (item.sleepAwakeMinutes !== undefined && item.sleepAwakeMinutes !== null && (Number(item.sleepAwakeMinutes) > 0 || !existing.SleepAwakeMinutes)) existing.SleepAwakeMinutes = Math.round(Number(item.sleepAwakeMinutes));

            if (item.weightKg !== undefined && item.weightKg !== null && (Number(item.weightKg) > 0 || !existing.WeightKg)) existing.WeightKg = Number(item.weightKg);
            if (item.bmi !== undefined && item.bmi !== null) existing.Bmi = Number(item.bmi);
            if (item.waterLiters !== undefined && item.waterLiters !== null) existing.WaterLiters = Number(item.waterLiters);
            if (item.bloodGlucoseMgDl !== undefined && item.bloodGlucoseMgDl !== null) existing.BloodGlucoseMgDl = Number(item.bloodGlucoseMgDl);

            if (item.rawHourlyJson) {
                existing.RawHourlyJson = typeof item.rawHourlyJson === "string" ? item.rawHourlyJson : JSON.stringify(item.rawHourlyJson);
            }
            if (item.rawMetricsJson) {
                existing.RawMetricsJson = typeof item.rawMetricsJson === "string" ? item.rawMetricsJson : JSON.stringify(item.rawMetricsJson);
            }

            const saved = await this.fitnessRepo.save(existing);
            synced.push(saved);
        }

        return {
            success: true,
            syncedCount: synced.length,
            message: `Successfully synced ${synced.length} fitness records`
        };
    }

    /**
     * Retrieve fitness summary, stats, and chart trend points.
     */
    async getFitnessSummary(patientId: string, period: "day" | "week" | "month" = "week", todayDate?: string) {
        if (!patientId) throw new Error("patientId is required");

        const daysLimit = period === "day" ? 1 : period === "week" ? 7 : 30;

        // Fetch past N days of records
        const records = await this.fitnessRepo
            .createQueryBuilder("f")
            .where("f.PatientId = :patientId", { patientId })
            .orderBy("f.Date", "DESC")
            .take(daysLimit)
            .getMany();

        // Date normalizer helper to handle Date objects and string formats
        const normalizeDate = (d: any): string => {
            if (!d) return "";
            if (d instanceof Date) return d.toISOString().split("T")[0];
            return String(d).split("T")[0];
        };

        // Normalize SpO2 helper (converts legacy decimal ratios like 0.99 into 99.0)
        const normalizeSpo2 = (val: any): number => {
            const n = Number(val || 0);
            if (n > 0 && n <= 1.0) return Number((n * 100.0).toFixed(1));
            return Number(n.toFixed(1));
        };

        // Today's record: match client's local date if provided, otherwise server UTC date
        const targetToday = todayDate || new Date().toISOString().split("T")[0];
        const todayRecord = records.find(r => normalizeDate(r.Date) === targetToday) || records[0] || null;

        // Reverse to chronological order (Oldest -> Newest) for charts
        const chronological = [...records].reverse();

        // Chart data points
        const chartPoints = chronological.map(r => {
            let hourly: any[] = [];
            if (r.RawHourlyJson) {
                try {
                    hourly = JSON.parse(r.RawHourlyJson);
                } catch (_) {}
            }

            return {
                date: normalizeDate(r.Date),
                steps: r.Steps || 0,
                calories: r.Calories || 0,
                distanceMeters: r.DistanceMeters || 0,
                heartRateAvg: r.HeartRateAvg || 0,
                heartRateMin: r.HeartRateMin || 0,
                heartRateMax: r.HeartRateMax || 0,
                restingHeartRate: r.RestingHeartRate || 0,
                bloodOxygen: normalizeSpo2(r.BloodOxygen),
                sleepMinutes: r.SleepMinutes || 0,
                sleepDeepMinutes: r.SleepDeepMinutes || 0,
                sleepRemMinutes: r.SleepRemMinutes || 0,
                weightKg: r.WeightKg || 0,
                hourly
            };
        });

        // Compute aggregated analytics
        const validSteps = chartPoints.map(p => p.steps).filter(s => s > 0);
        const validCals = chartPoints.map(p => p.calories).filter(c => c > 0);
        const validHR = chartPoints.map(p => p.heartRateAvg).filter(h => h > 0);
        const validSleep = chartPoints.map(p => p.sleepMinutes).filter(s => s > 0);

        const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
        const sum = (arr: number[]) => Math.round(arr.reduce((a, b) => a + b, 0));
        const max = (arr: number[]) => arr.length ? Math.max(...arr) : 0;
        const min = (arr: number[]) => arr.length ? Math.min(...arr) : 0;

        const analytics = {
            steps: {
                average: avg(validSteps),
                peak: max(validSteps),
                lowest: min(validSteps),
                total: sum(validSteps),
                count: validSteps.length
            },
            calories: {
                average: avg(validCals),
                peak: max(validCals),
                lowest: min(validCals),
                total: sum(validCals)
            },
            heartRate: {
                average: avg(validHR),
                peak: max(validHR),
                lowest: min(validHR)
            },
            sleep: {
                averageMinutes: avg(validSleep),
                totalMinutes: sum(validSleep),
                averageHoursFormatted: `${Math.floor(avg(validSleep) / 60)}h ${avg(validSleep) % 60}m`
            }
        };

        return {
            patientId,
            period,
            today: todayRecord ? {
                date: normalizeDate(todayRecord.Date),
                steps: todayRecord.Steps || 0,
                calories: todayRecord.Calories || 0,
                distanceMeters: todayRecord.DistanceMeters || 0,
                heartRateAvg: todayRecord.HeartRateAvg || 0,
                heartRateMin: todayRecord.HeartRateMin || 0,
                heartRateMax: todayRecord.HeartRateMax || 0,
                restingHeartRate: todayRecord.RestingHeartRate || 0,
                bloodOxygen: normalizeSpo2(todayRecord.BloodOxygen),
                sleepMinutes: todayRecord.SleepMinutes || 0,
                sleepFormatted: `${Math.floor((todayRecord.SleepMinutes || 0) / 60)}h ${(todayRecord.SleepMinutes || 0) % 60}m`,
                weightKg: todayRecord.WeightKg || 0,
                source: todayRecord.Source,
                lastSynced: todayRecord.UpdatedAt || todayRecord.CreatedAt
            } : null,
            analytics,
            chartPoints,
            history: records
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
                date: latest.Date,
                steps: latest.Steps || 0,
                calories: latest.Calories || 0,
                heartRate: latest.HeartRateAvg || 0,
                sleepMinutes: latest.SleepMinutes || 0
            } : null
        };
    }
}

export const patientFitnessService = new PatientFitnessService();
