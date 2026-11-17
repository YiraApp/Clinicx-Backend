import { Request, Response } from "express";
import { profileShareService, ShareLinkError } from "../../services/consent/profile-share.service.js";
import { patientAccessConsentService } from "../../services/consent/patient-access-consent.service.js";
import { isFamilyLinked } from "../../../../middlewares/request-identity.js";
import { AppDataSource } from "../../../../config/database.js";
import { User } from "../../../../models/Account/user.model.js";

const requesterOf = (req: Request) => String((req as any).user?.userId || (req as any).user?.id || "");

function fail(res: Response, error: any, fallback: string) {
    if (error instanceof ShareLinkError) {
        return res.status(error.status).json({ success: false, message: error.message });
    }
    console.error(`[ProfileShare] ${fallback}:`, error?.message);
    return res.status(500).json({ success: false, message: fallback });
}

export class ProfileShareController {
    /**
     * GET /v1/api/auth/provider/patients/:patientId/past-records?appointmentId=&hospitalId=
     *
     * The patient's history for the doctor's appointment page. With the
     * patient's consent (or for the patient's own family) it covers every
     * hospital; otherwise hospital staff see only records made at the
     * appointment's hospital. The visit being viewed is left out.
     */
    async pastRecords(req: Request, res: Response) {
        try {
            const requesterId = requesterOf(req);
            const patientId = String(req.params.patientId || "").trim();
            if (!patientId || !requesterId) return res.status(400).json({ success: false, message: "patientId is required" });
            const appointmentId = Number(req.query.appointmentId) || undefined;
            const requestedHospitalId = Number(req.query.hospitalId) || undefined;

            let scope: "all" | "hospital" | null = null;
            let hospitalId: number | undefined;
            if (patientId.toLowerCase() === requesterId.toLowerCase() || (await isFamilyLinked(requesterId, patientId))) {
                scope = "all";
            }
            const consent = scope ? null : await patientAccessConsentService.checkAccess(patientId, requesterId);
            if (!scope && consent?.hasAccess) scope = "all";
            if (!scope && (requestedHospitalId || appointmentId)) {
                const hospital = await patientAccessConsentService.checkHospitalRecordAccess(patientId, requesterId, {
                    hospitalId: requestedHospitalId,
                    appointmentId,
                });
                if (hospital.allowed) {
                    scope = "hospital";
                    hospitalId = hospital.hospitalId;
                }
            }
            if (!scope) {
                return res.status(403).json({
                    success: false,
                    message: "The patient hasn't given you access to their past records.",
                    data: { code: "CONSENT_REQUIRED", consentStatus: consent?.status ?? "NO_REQUEST" },
                });
            }

            const patient = await AppDataSource.getRepository(User).findOne({ where: { Id: patientId, IsDeleted: false } });
            if (!patient) return res.status(404).json({ success: false, message: "Patient not found" });

            const bundle = await profileShareService.buildPatientBundle(patient, {
                hospitalId: scope === "hospital" ? hospitalId : undefined,
                excludeAppointmentId: appointmentId,
            });
            res.setHeader("Cache-Control", "no-store");
            return res.json({
                success: true,
                data: {
                    scope,
                    accessExpiresAt: scope === "all" ? consent?.consent?.ExpiresAt ?? null : null,
                    ...bundle,
                },
            });
        } catch (error: any) {
            return fail(res, error, "Could not load past records");
        }
    }

    /** POST /v1/api/auth/patient/share-links { patientId?, duration, label? } */
    async create(req: Request, res: Response) {
        try {
            const requesterId = requesterOf(req);
            const patientId = String(req.body?.patientId || requesterId);
            const data = await profileShareService.createLink(requesterId, patientId, req.body?.duration, req.body?.label);
            return res.status(201).json({ success: true, message: "Link created", data });
        } catch (error: any) {
            return fail(res, error, "Could not create the link");
        }
    }

    /** GET /v1/api/auth/patient/share-links?patientId= */
    async list(req: Request, res: Response) {
        try {
            const requesterId = requesterOf(req);
            const patientId = String(req.query.patientId || requesterId);
            const data = await profileShareService.listLinks(requesterId, patientId);
            return res.json({ success: true, data });
        } catch (error: any) {
            return fail(res, error, "Could not load your links");
        }
    }

    /** POST /v1/api/auth/patient/share-links/:id/revoke */
    async revoke(req: Request, res: Response) {
        try {
            const data = await profileShareService.revokeLink(requesterOf(req), Number(req.params.id));
            return res.json({ success: true, message: "Link turned off", data });
        } catch (error: any) {
            return fail(res, error, "Could not turn the link off");
        }
    }

    /** GET /v1/api/auth/shared-profile/:token — public, no login. */
    async view(req: Request, res: Response) {
        try {
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("X-Robots-Tag", "noindex, nofollow");
            const data = await profileShareService.getSharedProfile(String(req.params.token || ""));
            return res.json({ success: true, data });
        } catch (error: any) {
            return fail(res, error, "Could not open this profile");
        }
    }

    /** POST /v1/api/auth/patient-access/grant { patientId?, doctorId, duration, hospitalId? } — the patient shares with a Yira doctor. */
    async grant(req: Request, res: Response) {
        try {
            const requesterId = requesterOf(req);
            const patientId = String(req.body?.patientId || requesterId);
            const { isFamilyLinked } = await import("../../../../middlewares/request-identity.js");
            if (!requesterId || !(await isFamilyLinked(requesterId, patientId))) {
                return res.status(403).json({ success: false, message: "You can only share your own profile or a family member's." });
            }
            if (!req.body?.doctorId) {
                return res.status(400).json({ success: false, message: "Choose a doctor to share with." });
            }
            const data = await patientAccessConsentService.grantAccess(
                patientId,
                String(req.body.doctorId),
                String(req.body.duration || "7_DAYS"),
                req.body.hospitalId ? Number(req.body.hospitalId) : undefined,
            );
            return res.json({ success: true, message: "Access given", data });
        } catch (error: any) {
            const known = /not found|not a doctor|required/i.test(error?.message ?? "");
            return res.status(known ? 400 : 500).json({ success: false, message: known ? error.message : "Could not share your profile" });
        }
    }
}

export const profileShareController = new ProfileShareController();
