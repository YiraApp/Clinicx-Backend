import { Request, Response } from "express";
import { patientAccessConsentService } from "../../services/consent/patient-access-consent.service.js";
import { isFamilyLinked } from "../../../../middlewares/request-identity.js";
import { actingProfileId, requireTokenActor } from "../../../../utils/request-actor.js";

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

            // Tell the patient: until now a request sat unseen until they happened to open
            // the consents screen. A family member's request also reaches the account holder.
            try {
                const { pushNotificationService } = await import("../../../../services/Notifications/push-notification.service.js");
                const { AppDataSource } = await import("../../../../config/database.js");
                const { User } = await import("../../../../models/Account/user.model.js");
                const doctor = await AppDataSource.getRepository(User).findOne({ where: { Id: doctorId } }).catch(() => null);
                const full = `${doctor?.FirstName || ""} ${doctor?.LastName || ""}`.trim();
                const doctorName = !full ? "A doctor" : full.toLowerCase().startsWith("dr") ? full : `Dr. ${full}`;
                await pushNotificationService.sendNotification({
                    userId: String(patientId),
                    senderId: String(doctorId),
                    title: "Access to your health records",
                    body: `${doctorName} asks to see your health records, fitness and vitals (${result?.durationLabel || "7 days"}). Open to approve or decline.`,
                    type: "CONSENT_REQUEST",
                    referenceId: String(result?.Id ?? ""),
                    route: "/patientConsentsScreen",
                    additionalData: { consentId: result?.Id, doctorId, duration: duration || "7_DAYS" },
                });
            } catch (notifyError: any) {
                console.error("[PatientAccess] Could not notify the patient of the request:", notifyError?.message);
            }

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
     * Doctor asks for access by OTP: sends a code to the patient's phone.
     * POST /v1/api/auth/patient-access/otp/send  { patientId, hospitalId? }
     */
    async sendAccessOtp(req: Request, res: Response) {
        try {
            const doctorId = String((req as any).user?.userId || (req as any).user?.id || "").trim();
            const { patientId, hospitalId } = req.body || {};
            if (!patientId) return res.status(400).json({ success: false, message: "patientId is required" });
            const result = await patientAccessConsentService.sendAccessOtp(String(patientId), doctorId, hospitalId ? Number(hospitalId) : undefined);
            return res.status(200).json({ success: true, message: `OTP sent to ${result.sentTo}`, data: result });
        } catch (error: any) {
            return res.status(400).json({ success: false, message: error.message || "Couldn't send the OTP." });
        }
    }

    /**
     * Doctor enters the OTP the patient read out; when right, access is granted.
     * POST /v1/api/auth/patient-access/otp/verify  { patientId, sessionId, otp, duration?, hospitalId? }
     */
    async verifyAccessOtp(req: Request, res: Response) {
        try {
            const doctorId = String((req as any).user?.userId || (req as any).user?.id || "").trim();
            const { patientId, sessionId, otp, duration, hospitalId } = req.body || {};
            if (!patientId || !sessionId || !otp) {
                return res.status(400).json({ success: false, message: "patientId, sessionId and otp are required" });
            }
            const result = await patientAccessConsentService.verifyAccessOtp(
                String(patientId), doctorId, String(sessionId), String(otp), duration || "7_DAYS", hospitalId ? Number(hospitalId) : undefined
            );
            return res.status(200).json({ success: true, message: "Access granted.", data: result });
        } catch (error: any) {
            return res.status(400).json({ success: false, message: error.message || "Couldn't check the OTP." });
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

            const caller = actingProfileId(req);
            if (!caller || !(await isFamilyLinked(caller, String(patientId)))) {
                return res.status(403).json({ success: false, message: "You can only see who can access your own or your family's records." });
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
            // Access given outlasts the request, so a token must prove who gives it.
            if (!requireTokenActor(req, res)) return;
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

            // Notify BOTH doctor and patient of the decision
            try {
                const { pushNotificationService } = await import("../../../../services/Notifications/push-notification.service.js");
                const { AppDataSource } = await import("../../../../config/database.js");
                const { User } = await import("../../../../models/Account/user.model.js");

                const userRepo = AppDataSource.getRepository(User);
                const pId = patientId || result.PatientId;
                const dId = result.DoctorId;

                let patientName = "Patient";
                if (pId) {
                    const pUser = await userRepo.findOne({ where: { Id: pId } }).catch(() => null);
                    if (pUser) {
                        patientName = `${pUser.FirstName || ""} ${pUser.LastName || ""}`.trim() || "Patient";
                    }
                }

                let doctorName = "Doctor";
                if (dId) {
                    const dUser = await userRepo.findOne({ where: { Id: dId } }).catch(() => null);
                    if (dUser) {
                        const dFull = `${dUser.FirstName || ""} ${dUser.LastName || ""}`.trim();
                        doctorName = dFull.toLowerCase().startsWith("dr.") ? dFull : `Dr. ${dFull}`;
                    }
                }

                const actionUpper = action.toUpperCase();
                const durationText = result.durationLabel || "requested duration";

                if (actionUpper === "APPROVE") {
                    // 1. Notify Doctor: Access Granted
                    if (dId) {
                        await pushNotificationService.sendNotification({
                            userId: dId,
                            senderId: pId,
                            title: "Record Access Granted",
                            body: `${patientName} has granted your request to access their medical records (${durationText}).`,
                            type: "CONSENT_APPROVED",
                            referenceId: String(consentId),
                            route: "/doctorDashboard",
                            additionalData: { consentId, patientId: pId, action: "APPROVE", duration: durationText }
                        });
                    }

                    // 2. Notify Patient: Confirmation of Access Granted
                    if (pId) {
                        await pushNotificationService.sendNotification({
                            userId: pId,
                            senderId: dId,
                            title: "Record Access Granted",
                            body: `You have granted ${doctorName} access to your medical records (${durationText}).`,
                            type: "CONSENT_APPROVED",
                            referenceId: String(consentId),
                            route: "/patientConsentsScreen",
                            additionalData: { consentId, doctorId: dId, action: "APPROVE", duration: durationText },
                            // The patient did this themself: list it, no push.
                            push: false
                        });
                    }
                } else if (actionUpper === "REVOKE") {
                    // 1. Notify Doctor: Access Revoked
                    if (dId) {
                        await pushNotificationService.sendNotification({
                            userId: dId,
                            senderId: pId,
                            title: "Record Access Revoked",
                            body: `${patientName} has revoked your access to their medical records.`,
                            type: "CONSENT_REVOKED",
                            referenceId: String(consentId),
                            route: "/doctorDashboard",
                            additionalData: { consentId, patientId: pId, action: "REVOKE" }
                        });
                    }

                    // 2. Notify Patient: Confirmation of Access Revoked
                    if (pId) {
                        await pushNotificationService.sendNotification({
                            userId: pId,
                            senderId: dId,
                            title: "Record Access Revoked",
                            body: `You have revoked ${doctorName}'s access to your medical records.`,
                            type: "CONSENT_REVOKED",
                            referenceId: String(consentId),
                            route: "/patientConsentsScreen",
                            additionalData: { consentId, doctorId: dId, action: "REVOKE" },
                            // The patient did this themself: list it, no push.
                            push: false
                        });
                    }
                } else if (actionUpper === "REJECT") {
                    // 1. Notify Doctor: Access Declined
                    if (dId) {
                        await pushNotificationService.sendNotification({
                            userId: dId,
                            senderId: pId,
                            title: "Record Access Declined",
                            body: `${patientName} has declined your request to access their medical records.`,
                            type: "CONSENT_REJECTED",
                            referenceId: String(consentId),
                            route: "/doctorDashboard",
                            additionalData: { consentId, patientId: pId, action: "REJECT" }
                        });
                    }

                    // 2. Notify Patient: Confirmation of Access Declined
                    if (pId) {
                        await pushNotificationService.sendNotification({
                            userId: pId,
                            senderId: dId,
                            title: "Record Access Declined",
                            body: `You have declined ${doctorName}'s request to access your medical records.`,
                            type: "CONSENT_REJECTED",
                            referenceId: String(consentId),
                            route: "/patientConsentsScreen",
                            additionalData: { consentId, doctorId: dId, action: "REJECT" },
                            // The patient did this themself: list it, no push.
                            push: false
                        });
                    }
                }

                console.log(`[ConsentNotification] Dispatched full notifications for ${actionUpper} to doctor ${dId} and patient ${pId}`);
            } catch (notifErr) {
                console.error("[PatientAccessConsentController] Consent response notification warning:", notifErr);
            }

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

    /**
     * Connects patient and doctor directly via QR scan.
     */
    async connectDoctorPatient(req: Request, res: Response): Promise<Response> {
        try {
            const { doctorId, patientUserId, hospitalId, orgId } = req.body;
            // Scanning gives the doctor 30 days of access, so only the patient or their family can do it.
            const signedIn = requireTokenActor(req, res);
            if (!signedIn) return res;
            const open = actingProfileId(req) || signedIn;
            const targetPatientUserId = String(patientUserId || open);
            if (!(await isFamilyLinked(open, targetPatientUserId))) {
                return res.status(403).json({ status: false, message: "You can only connect yourself or your family with a doctor." });
            }

            if (!doctorId) {
                return res.status(400).json({
                    status: false,
                    message: "doctorId is required"
                });
            }

            const result = await patientAccessConsentService.connectPatientByQr(
                targetPatientUserId,
                doctorId,
                hospitalId ? Number(hospitalId) : undefined,
                orgId ? Number(orgId) : undefined
            );

            return res.status(200).json({
                status: true,
                success: true,
                message: "Patient connected with doctor successfully",
                data: result
            });
        } catch (error: any) {
            console.error("Error connecting patient with doctor:", error);
            return res.status(400).json({
                status: false,
                message: error.message || "Failed to connect patient with doctor"
            });
        }
    }
}

export const patientAccessConsentController = new PatientAccessConsentController();
