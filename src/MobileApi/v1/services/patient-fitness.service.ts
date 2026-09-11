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

            let existing = await this.fitnessRepo.findOne({
                where: { PatientId: patientId, Date: dateStr }
            }).catch(() => null);

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

            // Assign numerical fields if provided and valid
            if (item.steps !== undefined && item.steps !== null) existing.Steps = Math.round(Number(item.steps));
            if (item.calories !== undefined && item.calories !== null) existing.Calories = Number(item.calories);
            if (item.distanceMeters !== undefined && item.distanceMeters !== null) existing.DistanceMeters = Number(item.distanceMeters);
            if (item.activeMinutes !== undefined && item.activeMinutes !== null) existing.ActiveMinutes = Math.round(Number(item.activeMinutes));
            if (item.flightsClimbed !== undefined && item.flightsClimbed !== null) existing.FlightsClimbed = Math.round(Number(item.flightsClimbed));

            if (item.heartRateAvg !== undefined && item.heartRateAvg !== null) existing.HeartRateAvg = Number(item.heartRateAvg);
            if (item.heartRateMin !== undefined && item.heartRateMin !== null) existing.HeartRateMin = Number(item.heartRateMin);
            if (item.heartRateMax !== undefined && item.heartRateMax !== null) existing.HeartRateMax = Number(item.heartRateMax);
            if (item.restingHeartRate !== undefined && item.restingHeartRate !== null) existing.RestingHeartRate = Number(item.restingHeartRate);
            if (item.bloodOxygen !== undefined && item.bloodOxygen !== null) existing.BloodOxygen = Number(item.bloodOxygen);
            if (item.bloodPressureSys !== undefined && item.bloodPressureSys !== null) existing.BloodPressureSys = Number(item.bloodPressureSys);
            if (item.bloodPressureDia !== undefined && item.bloodPressureDia !== null) existing.BloodPressureDia = Number(item.bloodPressureDia);

            if (item.sleepMinutes !== undefined && item.sleepMinutes !== null) existing.SleepMinutes = Math.round(Number(item.sleepMinutes));
            if (item.sleepDeepMinutes !== undefined && item.sleepDeepMinutes !== null) existing.SleepDeepMinutes = Math.round(Number(item.sleepDeepMinutes));
            if (item.sleepRemMinutes !== undefined && item.sleepRemMinutes !== null) existing.SleepRemMinutes = Math.round(Number(item.sleepRemMinutes));
            if (item.sleepLightMinutes !== undefined && item.sleepLightMinutes !== null) existing.SleepLightMinutes = Math.round(Number(item.sleepLightMinutes));
            if (item.sleepAwakeMinutes !== undefined && item.sleepAwakeMinutes !== null) existing.SleepAwakeMinutes = Math.round(Number(item.sleepAwakeMinutes));

            if (item.weightKg !== undefined && item.weightKg !== null) existing.WeightKg = Number(item.weightKg);
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
    async getFitnessSummary(patientId: string, period: "day" | "week" | "month" = "week") {
        if (!patientId) throw new Error("patientId is required");

        const daysLimit = period === "day" ? 1 : period === "week" ? 7 : 30;

        // Fetch past N days of records
        const records = await this.fitnessRepo
            .createQueryBuilder("f")
            .where("f.PatientId = :patientId", { patientId })
            .orderBy("f.Date", "DESC")
            .take(daysLimit)
            .getMany();

        // Today's record
        const todayStr = new Date().toISOString().split("T")[0];
        const todayRecord = records.find(r => r.Date === todayStr) || records[0] || null;

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
                date: r.Date,
                steps: r.Steps || 0,
                calories: r.Calories || 0,
                distanceMeters: r.DistanceMeters || 0,
                heartRateAvg: r.HeartRateAvg || 0,
                heartRateMin: r.HeartRateMin || 0,
                heartRateMax: r.HeartRateMax || 0,
                restingHeartRate: r.RestingHeartRate || 0,
                bloodOxygen: r.BloodOxygen || 0,
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
                date: todayRecord.Date,
                steps: todayRecord.Steps || 0,
                calories: todayRecord.Calories || 0,
                distanceMeters: todayRecord.DistanceMeters || 0,
                heartRateAvg: todayRecord.HeartRateAvg || 0,
                heartRateMin: todayRecord.HeartRateMin || 0,
                heartRateMax: todayRecord.HeartRateMax || 0,
                restingHeartRate: todayRecord.RestingHeartRate || 0,
                bloodOxygen: todayRecord.BloodOxygen || 0,
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
