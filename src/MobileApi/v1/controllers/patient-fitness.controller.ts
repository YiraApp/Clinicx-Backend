import { Request, Response } from "express";
import { patientFitnessService } from "../services/patient-fitness.service.js";
import { patientAccessConsentService } from "../services/consent/patient-access-consent.service.js";
import { isFamilyLinked } from "../../../middlewares/request-identity.js";
import { ApiResponse } from "../../../utils/response.utils.js";

const requesterOf = (req: Request) => String((req as any).user?.userId || (req as any).user?.id || "").trim();

/**
 * Who a fitness request is about, and whether the caller may act for them.
 * Writing is limited to the patient and their family accounts. Reading also
 * allows a doctor the patient has given record access to.
 */
async function resolvePatient(req: Request, rawPatientId: any, mode: "read" | "write") {
    const requesterId = requesterOf(req);
    const patientId = String(rawPatientId || requesterId || "").trim();
    if (!patientId) return { patientId: "", error: 400, message: "Patient ID is required" };
    if (!requesterId || patientId.toLowerCase() === requesterId.toLowerCase()) return { patientId };
    if (await isFamilyLinked(requesterId, patientId)) return { patientId };
    if (mode === "read") {
        const access = await patientAccessConsentService.checkAccess(patientId, requesterId).catch(() => null);
        if (access?.hasAccess) return { patientId };
    }
    return { patientId, error: 403, message: "You can't access this person's fitness data." };
}

export class PatientFitnessController {
    /**
     * Batch upsert fitness records from device (Apple Health / Google Health Connect)
     * POST /v1/api/auth/patient/fitness/sync
     */
    async syncFitness(req: Request, res: Response): Promise<Response> {
        try {
            const target = await resolvePatient(req, req.body.patientId, "write");
            if (target.error) return res.status(target.error).json(ApiResponse.error(target.message!));

            const source = req.body.source || "Unknown";
            const records = req.body.records || [];
            const result = await patientFitnessService.syncFitnessBatch(target.patientId, source, records, {
                schema: Number(req.body.schema) || 1,
                repair: req.body.repair === true,
            });
            return res.status(200).json(ApiResponse.success(result, "Fitness records synced successfully"));
        } catch (error: any) {
            console.error("❌ Error syncing fitness data:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to sync fitness data"));
        }
    }

    /**
     * Get historical fitness summary and chart trends
     * GET /v1/api/auth/patient/fitness/summary?patientId=...&period=day|week|month
     */
    async getFitnessSummary(req: Request, res: Response): Promise<Response> {
        try {
            const target = await resolvePatient(req, req.query.patientId, "read");
            if (target.error) return res.status(target.error).json(ApiResponse.error(target.message!));

            const rawPeriod = String(req.query.period || "week");
            const period = (["day", "week", "month"].includes(rawPeriod) ? rawPeriod : "week") as "day" | "week" | "month";
            const todayDate = req.query.todayDate as string | undefined;

            const summary = await patientFitnessService.getFitnessSummary(target.patientId, period, todayDate);
            return res.status(200).json(ApiResponse.success(summary, "Fitness summary retrieved"));
        } catch (error: any) {
            console.error("❌ Error retrieving fitness summary:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to retrieve fitness summary"));
        }
    }

    /**
     * Get fitness connection status and latest sync information
     * GET /v1/api/auth/patient/fitness/status?patientId=...
     */
    async getFitnessStatus(req: Request, res: Response): Promise<Response> {
        try {
            const target = await resolvePatient(req, req.query.patientId, "read");
            if (target.error) return res.status(target.error).json(ApiResponse.error(target.message!));

            const status = await patientFitnessService.getFitnessStatus(target.patientId);
            return res.status(200).json(ApiResponse.success(status, "Fitness status retrieved"));
        } catch (error: any) {
            console.error("❌ Error retrieving fitness status:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to retrieve fitness status"));
        }
    }

    /**
     * Disconnect fitness integration
     * POST /v1/api/auth/patient/fitness/disconnect
     */
    async disconnectFitness(req: Request, res: Response): Promise<Response> {
        try {
            const target = await resolvePatient(req, req.body.patientId, "write");
            if (target.error) return res.status(target.error).json(ApiResponse.error(target.message!));

            return res.status(200).json(ApiResponse.success({ disconnected: true }, "Fitness disconnected successfully"));
        } catch (error: any) {
            console.error("❌ Error disconnecting fitness:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to disconnect fitness"));
        }
    }
}

export const patientFitnessController = new PatientFitnessController();
