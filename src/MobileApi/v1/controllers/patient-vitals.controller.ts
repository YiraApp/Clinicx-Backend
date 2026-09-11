import { Request, Response } from "express";
import { AppDataSource } from "../../../config/database.js";
import { User } from "../../../models/Account/user.model.js";
import { PatientMedicalRecord } from "../../../models/Appointments/patient-medical-record.model.js";
import { ApiResponse } from "../../../utils/response.utils.js";

export class PatientVitalsController {
    /**
     * Get real dynamic vitals (both current latest reading and complete historical logs).
     * Strictly zero static/mock fallback data.
     */
    async getPatientVitals(req: Request, res: Response): Promise<Response> {
        try {
            const patientId = (req.params.patientId || req.query.patientId || (req as any).user?.userId) as string;

            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required"));
            }

            const userRepo = AppDataSource.getRepository(User);
            const pmrRepo = AppDataSource.getRepository(PatientMedicalRecord);

            const user = await userRepo.findOne({
                where: { Id: patientId }
            }).catch(() => null);

            const allRecords = await pmrRepo.find({
                where: { PatientId: patientId },
                relations: ["Doctor"],
                order: { Date: "DESC", CreatedAt: "DESC" }
            }).catch(() => []);

            const hasVal = (val?: string | null) => Boolean(val && val.trim().length > 0 && val.trim() !== "--" && val.trim() !== "null");

            // Filter records that have at least one valid vital measurement
            const vitalsRecords = allRecords.filter(r => 
                hasVal(r.BloodPressure) ||
                hasVal(r.HeartRate) ||
                hasVal(r.Temperature) ||
                hasVal(r.SpO2) ||
                hasVal(r.Weight) ||
                hasVal(r.Height)
            );

            // Build dynamic history logs
            const history = vitalsRecords.map(record => {
                let recordedBy = "Self";
                if (record.Doctor) {
                    recordedBy = `Dr. ${record.Doctor.FirstName || ""} ${record.Doctor.LastName || ""}`.trim();
                } else if (record.CreatedBy && record.CreatedBy !== "Doctor") {
                    recordedBy = record.CreatedBy;
                }

                const rawBp = record.BloodPressure ? record.BloodPressure.trim() : "";
                let bpSys = "";
                let bpDia = "";
                if (rawBp.includes("/")) {
                    const parts = rawBp.split("/");
                    bpSys = parts[0].trim();
                    bpDia = parts.length > 1 ? parts[1].trim() : "";
                }

                const dt = record.Date || record.CreatedAt || new Date();

                return {
                    id: record.Id,
                    timestamp: dt instanceof Date ? dt.toISOString() : new Date(dt).toISOString(),
                    bp: rawBp || "--",
                    bpSystolic: bpSys || "--",
                    bpDiastolic: bpDia || "--",
                    pulse: record.HeartRate ? record.HeartRate.trim() : "--",
                    temp: record.Temperature ? record.Temperature.trim() : "--",
                    spO2: record.SpO2 ? record.SpO2.trim() : "--",
                    weight: record.Weight ? record.Weight.trim() : "--",
                    height: record.Height ? record.Height.trim() : "--",
                    recordedBy,
                    type: record.Type || "Vitals Check"
                };
            });

            // Resolve latest dynamic current vitals (latest medical record takes priority, then user record)
            const latest = vitalsRecords.length > 0 ? vitalsRecords[0] : null;

            const bp = latest?.BloodPressure || user?.BloodPressure || "";
            let bpSys = "";
            let bpDia = "";
            if (bp && bp.includes("/")) {
                const parts = bp.split("/");
                bpSys = parts[0].trim();
                bpDia = parts.length > 1 ? parts[1].trim() : "";
            }

            const pulse = latest?.HeartRate || user?.HeartRate || "";
            const temp = latest?.Temperature || user?.Temperature || "";
            const spO2 = latest?.SpO2 || user?.SpO2 || "";
            const weight = latest?.Weight || (user?.Weight != null ? String(user.Weight) : "");
            const height = latest?.Height || (user?.Height != null ? String(user.Height) : "");

            let lastUpdated = "";
            if (latest?.Date || latest?.CreatedAt) {
                const dt = latest.Date || latest.CreatedAt;
                lastUpdated = dt instanceof Date ? dt.toISOString() : new Date(dt).toISOString();
            } else if (user?.UpdatedAt) {
                lastUpdated = user.UpdatedAt instanceof Date ? user.UpdatedAt.toISOString() : new Date(user.UpdatedAt).toISOString();
            }

            const current: Record<string, string> = {};
            if (bp && bp !== "--") {
                current.bp = bp;
                if (bpSys) current.bpSystolic = bpSys;
                if (bpDia) current.bpDiastolic = bpDia;
            }
            if (pulse && pulse !== "--") current.pulse = pulse;
            if (temp && temp !== "--") current.temp = temp;
            if (spO2 && spO2 !== "--") current.spO2 = spO2;
            if (weight && weight !== "--") current.weight = weight;
            if (height && height !== "--") current.height = height;
            if (lastUpdated) current.lastUpdated = lastUpdated;

            return res.json(ApiResponse.success({
                current,
                history,
                totalReadings: history.length
            }, "Patient vitals retrieved successfully"));
        } catch (error: any) {
            console.error("Patient Vitals Retrieval Error:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to retrieve vitals"));
        }
    }

    /**
     * Record new dynamic vitals reading for patient.
     * Updates Users table and saves an entry into PatientMedicalRecord.
     */
    async recordPatientVitals(req: Request, res: Response): Promise<Response> {
        try {
            const body = req.body || {};
            const patientId = body.patientId || (req as any).user?.userId;

            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required"));
            }

            const userRepo = AppDataSource.getRepository(User);
            const pmrRepo = AppDataSource.getRepository(PatientMedicalRecord);

            const user = await userRepo.findOne({ where: { Id: patientId } });
            if (!user) {
                return res.status(404).json(ApiResponse.error("Patient not found"));
            }

            let computedBp = body.bp ? String(body.bp).trim() : "";
            if (!computedBp && (body.bpSystolic || body.bpDiastolic)) {
                const sys = body.bpSystolic ? String(body.bpSystolic).trim() : "";
                const dia = body.bpDiastolic ? String(body.bpDiastolic).trim() : "";
                if (sys && dia) computedBp = `${sys}/${dia}`;
                else if (sys) computedBp = sys;
                else if (dia) computedBp = dia;
            }

            const pulse = body.pulse ? String(body.pulse).trim() : (body.heartRate ? String(body.heartRate).trim() : null);
            const temp = body.temp ? String(body.temp).trim() : (body.temperature ? String(body.temperature).trim() : null);
            const spO2 = body.spO2 ? String(body.spO2).trim() : (body.spo2 ? String(body.spo2).trim() : (body.oxygenSaturation ? String(body.oxygenSaturation).trim() : null));
            const weight = body.weight ? String(body.weight).trim() : null;
            const height = body.height ? String(body.height).trim() : null;

            // 1. Update User profile vital registers
            if (computedBp) user.BloodPressure = computedBp;
            if (pulse) user.HeartRate = pulse;
            if (temp) user.Temperature = temp;
            if (spO2) user.SpO2 = spO2;
            if (weight) {
                const parsedW = parseFloat(weight);
                if (!isNaN(parsedW)) user.Weight = parsedW;
            }
            if (height) {
                const parsedH = parseFloat(height);
                if (!isNaN(parsedH)) user.Height = parsedH;
            }
            user.UpdatedAt = new Date();
            await userRepo.save(user);

            // 2. Insert new historical PatientMedicalRecord
            const record = pmrRepo.create({
                PatientId: patientId,
                Type: "Vitals Check",
                Date: new Date(),
                BloodPressure: computedBp || null,
                HeartRate: pulse || null,
                Temperature: temp || null,
                SpO2: spO2 || null,
                Weight: weight || null,
                Height: height || null,
                Status: "Completed",
                CreatedBy: (req as any).user?.firstName 
                    ? `${(req as any).user?.firstName} ${(req as any).user?.lastName || ''}`.trim() 
                    : "Patient"
            } as any);
            await pmrRepo.save(record);

            // 3. Re-invoke getPatientVitals logic to return the fresh dynamic dataset
            return this.getPatientVitals(req, res);
        } catch (error: any) {
            console.error("Patient Vitals Recording Error:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to record vitals"));
        }
    }
}

export const patientVitalsController = new PatientVitalsController();
