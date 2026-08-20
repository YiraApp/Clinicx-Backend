import { Request, Response } from "express";
import { patientAccessConsentService } from "../../services/consent/patient-access-consent.service.js";

export class PatientAccessConsentController {
    /**
     * Doctor requests access to patient records with selected duration.
     * POST /v1/api/auth/patient-access/request
     */
    async requestAccess(req: Request, res: Response) {
        try {
            const { patientId, duration, hospitalId, notes } = req.body;
            const doctorId = (req as any).user?.userId || (req as any).user?.id || req.body.doctorId;

            if (!patientId) {
                return res.status(400).json({
                    success: false,
                    message: "patientId is required"
                });
            }

            if (!doctorId) {
                return res.status(400).json({
                    success: false,
                    message: "Doctor context not found"
                });
            }

            const result = await patientAccessConsentService.requestAccess(
                patientId,
                doctorId,
                hospitalId ? Number(hospitalId) : undefined,
                duration || "7_DAYS",
                notes
            );

            return res.status(200).json({
                success: true,
                message: "Access request submitted to patient successfully",
                data: result
            });
        } catch (error: any) {
            console.error("Error requesting patient access consent:", error);
            return res.status(500).json({
                success: false,
                message: error.message || "Failed to request patient access"
            });
        }
    }

    /**
     * Checks if doctor has active approved access to patient records.
     * GET /v1/api/auth/patient-access/check
     */
    async checkAccess(req: Request, res: Response) {
        try {
            const patientId = (req.query.patientId as string) || (req.body?.patientId as string);
            const doctorId = (req as any).user?.userId || (req as any).user?.id || (req.query.doctorId as string) || (req.body?.doctorId as string);

            if (!patientId || !doctorId) {
                return res.status(400).json({
                    success: false,
                    message: "patientId and doctorId are required"
                });
            }

            const result = await patientAccessConsentService.checkAccess(patientId, doctorId);

            return res.status(200).json({
                success: true,
                data: result
            });
        } catch (error: any) {
            console.error("Error checking patient access consent:", error);
            return res.status(500).json({
                success: false,
                message: error.message || "Failed to check access consent"
            });
        }
    }

    /**
     * Retrieves all access requests for a patient.
     * GET /v1/api/auth/patient-access/patient-consents
     */
    async getPatientConsents(req: Request, res: Response) {
        try {
            const patientId = (req.query.patientId as string) || (req as any).user?.userId || (req as any).user?.id;

            if (!patientId) {
                return res.status(400).json({
                    success: false,
                    message: "patientId is required"
                });
            }

            const results = await patientAccessConsentService.getPatientConsents(patientId);

            return res.status(200).json({
                success: true,
                data: results
            });
        } catch (error: any) {
            console.error("Error fetching patient consents:", error);
            return res.status(500).json({
                success: false,
                message: error.message || "Failed to fetch patient consents"
            });
        }
    }

    /**
     * Patient approves, rejects, or revokes access request.
     * POST /v1/api/auth/patient-access/respond
     */
    async respondToConsent(req: Request, res: Response) {
        try {
            const { consentId, action } = req.body;
            const patientId = (req as any).user?.userId || (req as any).user?.id || req.body.patientId;

            if (!consentId) {
                return res.status(400).json({
                    success: false,
                    message: "consentId is required"
                });
            }

            if (!action || !["APPROVE", "REJECT", "REVOKE"].includes(action.toUpperCase())) {
                return res.status(400).json({
                    success: false,
                    message: "action must be APPROVE, REJECT, or REVOKE"
                });
            }

            const result = await patientAccessConsentService.respondToConsent(
                Number(consentId),
                patientId,
                action.toUpperCase() as "APPROVE" | "REJECT" | "REVOKE"
            );

            return res.status(200).json({
                success: true,
                message: `Consent request ${action.toLowerCase()}d successfully`,
                data: result
            });
        } catch (error: any) {
            console.error("Error responding to patient consent:", error);
            return res.status(500).json({
                success: false,
                message: error.message || "Failed to respond to consent request"
            });
        }
    }
}

export const patientAccessConsentController = new PatientAccessConsentController();
