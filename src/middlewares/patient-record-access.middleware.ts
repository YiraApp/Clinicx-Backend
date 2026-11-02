import type { NextFunction, Request, Response } from "express";
import { patientAccessConsentService } from "../MobileApi/v1/services/consent/patient-access-consent.service.js";
import { isFamilyLinked } from "./request-identity.js";
import { ApiResponse } from "../utils/response.utils.js";

/**
 * Guards a patient's records.
 *
 * - Patients read their own records, and family accounts read each other's.
 * - Records created at a hospital (asked for with hospitalId or appointmentId)
 *   are open to that hospital's staff without consent, as long as the patient
 *   has booked an appointment there or is registered with it.
 * - Anything else, including the full history across hospitals, needs an
 *   approved, unexpired access consent from the patient.
 */
export async function requirePatientRecordAccess(req: Request, res: Response, next: NextFunction) {
    try {
        const patientId = String(req.params.patientId || req.query.patientId || "").trim();
        const user = (req as any).user;
        const requesterId = String(user?.userId || user?.id || "").trim();

        if (!patientId || !requesterId || patientId.toLowerCase() === requesterId.toLowerCase()) {
            return next();
        }
        if (await isFamilyLinked(requesterId, patientId)) {
            return next();
        }

        const hospitalId = Number(req.query.hospitalId) || undefined;
        const appointmentId = Number(req.query.appointmentId) || undefined;
        if (hospitalId || appointmentId) {
            const hospitalAccess = await patientAccessConsentService.checkHospitalRecordAccess(patientId, requesterId, {
                hospitalId,
                appointmentId,
            });
            if (hospitalAccess.allowed) return next();
        }

        // A patient's consent covers every record, whatever the scope.
        const access = await patientAccessConsentService.checkAccess(patientId, requesterId);
        if (access?.hasAccess) return next();

        return res.status(403).json(
            ApiResponse.error(
                hospitalId || appointmentId
                    ? "You can only see records from your hospital for patients who visit it."
                    : "The patient hasn't given you access to their full records.",
                {
                    code: "CONSENT_REQUIRED",
                    consentStatus: access?.status ?? "NO_REQUEST",
                },
            ),
        );
    } catch (error: any) {
        console.error("[PatientRecordAccess] Access check failed:", error?.message);
        return res.status(500).json(ApiResponse.error("Could not verify access to this patient's records."));
    }
}
