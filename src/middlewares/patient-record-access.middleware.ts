import type { NextFunction, Request, Response } from "express";
import { patientAccessConsentService } from "../MobileApi/v1/services/consent/patient-access-consent.service.js";
import { ApiResponse } from "../utils/response.utils.js";

/**
 * Guards a patient's full record history. Anyone may read their own records,
 * and a doctor may read what is scoped to an appointment or their hospital.
 * Reading everything (no appointmentId and no hospitalId) as someone other
 * than the patient needs an approved, unexpired access consent from them.
 */
export async function requirePatientRecordAccess(req: Request, res: Response, next: NextFunction) {
    try {
        const patientId = String(req.params.patientId || req.query.patientId || "").trim();
        const user = (req as any).user;
        const requesterId = String(user?.userId || user?.id || "").trim();

        if (!patientId || !requesterId || patientId.toLowerCase() === requesterId.toLowerCase()) {
            return next();
        }
        if (req.query.appointmentId || req.query.hospitalId) {
            return next();
        }

        const access = await patientAccessConsentService.checkAccess(patientId, requesterId);
        if (access?.hasAccess) return next();

        return res.status(403).json(
            ApiResponse.error("The patient hasn't given you access to their full records.", {
                code: "CONSENT_REQUIRED",
                consentStatus: access?.status ?? "NO_REQUEST",
            }),
        );
    } catch (error: any) {
        console.error("[PatientRecordAccess] Consent check failed:", error?.message);
        return res.status(500).json(ApiResponse.error("Could not verify access to this patient's records."));
    }
}
