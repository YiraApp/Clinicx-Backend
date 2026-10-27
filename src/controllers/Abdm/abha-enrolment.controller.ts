import type { Request, Response } from "express";
import { ApiResponse } from "../../utils/response.utils.js";
import { abdmConfig } from "../../config/abdm.config.js";
import { AbdmApiError, type AbdmErrorKind } from "../../services/Abdm/abdm-gateway.service.js";
import QRCode from "qrcode";
import { AbhaEnrolmentService, AbhaJourneyError } from "../../services/Abdm/abha-enrolment.service.js";
import { AbhaLoginService } from "../../services/Abdm/abha-login.service.js";
import { AbhaShareService, assertCounterId, counterShareUrl, type ShareRow } from "../../services/Abdm/abha-share.service.js";
import { AbhaSessionStore } from "../../services/Abdm/abha-session.store.js";
import { abdmCallbackAuth } from "../../services/Abdm/abdm-callback-auth.service.js";
import { abhaRepository } from "../../repositories/Abdm/abha.repository.js";
import { abhaShareRepository } from "../../repositories/Abdm/abha-share.repository.js";
import { shareQueueHospital } from "./share-queue-access.js";
import { AbdmBridgeService, BridgeUrlError } from "../../services/Abdm/abdm-bridge.service.js";
import { abdmFacilities, FacilityClashError, FacilityError, hiuIdOf, scanShareHipIdOf } from "../../services/Abdm/abdm-facilities.service.js";
import { autoLinker } from "../../services/Abdm/m2/index.js";

// One session store: a journey verified by create, verify or find can then show its card and link a patient.
const abhaSessions = new AbhaSessionStore();
const abhaEnrolmentService = new AbhaEnrolmentService(abhaRepository, undefined, undefined, undefined, abhaSessions);
const abhaLoginService = new AbhaLoginService(abhaRepository, abhaSessions);
const abhaShareService = new AbhaShareService(abhaShareRepository);
const abdmBridgeService = new AbdmBridgeService(abhaRepository);

/** What the desk is told beside ABDM's own message, which is always passed on unchanged. */
const HINTS: Record<AbdmErrorKind, string | null> = {
    credentials: "ABDM refused this clinic's ABDM credentials. Ask your administrator to check the ABDM client id and secret. The patient's details are not the problem.",
    rejected: null,
    timeout: "Nothing was created. Try again.",
    unavailable: "ABDM isn't responding properly right now. Try again in a few minutes.",
    "not-configured": "Ask your administrator to add the ABDM client id and secret.",
    integration: "This needs your administrator: quote the request ID.",
};

const hintFor = (error: AbdmApiError): string | null => {
    if (error.kind === "rejected" && (error.field === "loginId" || error.field === "otpValue")) {
        const what = error.field === "otpValue" ? "OTP" : "encrypted number";
        return `ABDM could not read the ${what}. This is usually the encryption certificate or the server clock, not the patient's details. Try again; if it repeats, quote the request ID.`;
    }
    return HINTS[error.kind];
};

/**
 * The top-level message of an ABDM failure. ABDM's own words go in data.abdmMessage instead:
 * the frontend's HTTP client treats any error message containing "expired" as its own login
 * lapsing, and ABDM says "expired" about OTPs and user tokens.
 */
const SUMMARIES: Record<AbdmErrorKind, string> = {
    credentials: "ABDM refused the clinic's ABDM credentials.",
    rejected: "ABDM did not accept this request.",
    timeout: "ABDM did not reply in time.",
    unavailable: "ABDM is not responding properly.",
    "not-configured": "ABHA isn't set up for this clinic yet.",
    integration: "ABHA can't be used because of a setup problem.",
};

/** ABDM's 401 is never passed on as 401: the app would take it for its own login expiring. */
const statusFor = (kind: AbdmErrorKind): number => {
    switch (kind) {
        case "rejected": return 422;
        case "not-configured": return 503;
        case "timeout": return 504;
        default: return 502;
    }
};

const sendError = (res: Response, error: any) => {
    if (error instanceof AbhaJourneyError) {
        return res.status(error.status).json(ApiResponse.error(error.message, { kind: error.kind, ...error.details }));
    }
    if (error instanceof AbdmApiError) {
        return res.status(statusFor(error.kind)).json(ApiResponse.error(SUMMARIES[error.kind], {
            kind: error.kind,
            abdmMessage: error.message,
            hint: hintFor(error),
            abdmCode: error.code,
            field: error.field,
            requestId: error.requestId,
        }));
    }
    console.error("[ABDM] Unexpected error in ABHA enrolment:", error?.message);
    return res.status(500).json(ApiResponse.error("Something went wrong while talking to ABDM. Nothing was saved.", { kind: "unexpected" }));
};

const staffUserId = (req: Request): string => String((req as any).userId);
const headerNumber = (req: Request, name: string): number | null => {
    const value = Number(req.headers[name]);
    return Number.isFinite(value) && value > 0 ? value : null;
};

export class AbhaEnrolmentController {

    status(_req: Request, res: Response) {
        return res.json(ApiResponse.success({ configured: abdmConfig.isConfigured, abhaAddressSuffix: abdmConfig.abhaAddressSuffix }));
    }

    /** M2 readiness: the bridge, its callback URL and the HIP id, as ABDM's registry reports them. */
    async bridge(_req: Request, res: Response) {
        try {
            const readiness = await abdmBridgeService.checkReadiness();
            return res.json(ApiResponse.success(readiness, readiness.ready ? "ABDM can reach this HIP." : readiness.problems[0]));
        } catch (error) {
            return sendError(res, error);
        }
    }

    /**
     * Points the bridge at body.url and saves it as this deployment's. Moves every facility's
     * callbacks on this client id, so it is for system admins only (see the route).
     */
    async updateBridgeUrl(req: Request, res: Response) {
        const url = req.body?.url;
        if (!url) {
            return res.status(400).json(ApiResponse.error("Give the bridge URL.", { kind: "invalid" }));
        }
        try {
            const readiness = await abdmBridgeService.updateBridgeUrl(url);
            console.log(`[ABDM] bridge URL set to ${readiness.bridge.url} by user ${staffUserId(req)}`);
            return res.json(ApiResponse.success(readiness, `ABDM now calls back on ${readiness.bridge.url}.`));
        } catch (error) {
            if (error instanceof BridgeUrlError) {
                return res.status(400).json(ApiResponse.error(error.message, { kind: "invalid" }));
            }
            return sendError(res, error);
        }
    }

    /** Every hospital set up as an ABDM facility (system admins only, see the route). */
    async facilities(_req: Request, res: Response) {
        try {
            return res.json(ApiResponse.success(await abdmFacilities.all()));
        } catch (error) {
            return sendError(res, error);
        }
    }

    /**
     * Sets up a hospital as an ABDM facility: body.hipId is its HFR facility id, linked to this
     * deployment's bridge as HIP, and body.scanShareHipId the HIP id its Scan and Share counters
     * use when that is not the HFR id, and body.hiuId the HFR id it requests records as (M3) when
     * that is not its HIP id (one of the three is needed); hipName, autoLink and isActive are optional.
     * isActive false needs no id and frees the hospital's ids (refused while it has record requests open).
     */
    async saveFacility(req: Request, res: Response) {
        const hospitalId = Number(req.params.hospitalId);
        if (!Number.isInteger(hospitalId) || hospitalId <= 0) {
            return res.status(400).json(ApiResponse.error("Give a hospital id.", { kind: "invalid" }));
        }
        try {
            if (!(await abhaRepository.findHospitalName(hospitalId))) {
                return res.status(404).json(ApiResponse.error(`Hospital ${hospitalId} does not exist.`, { kind: "invalid" }));
            }
            const body = req.body ?? {};
            const saved = await abdmFacilities.save(hospitalId, {
                hipId: body.hipId,
                hiuId: body.hiuId,
                hipName: body.hipName,
                scanShareHipId: body.scanShareHipId,
                autoLink: body.autoLink === true,
                isActive: body.isActive !== false,
            }, (req as any).userId ? staffUserId(req) : null);
            const hiuId = saved ? hiuIdOf(saved) : null;
            console.log(`[ABDM] facility for hospital ${hospitalId} set to HIP ${saved?.hipId ?? "-"}, HIU ${hiuId ?? "-"} by user ${staffUserId(req)}`);
            return res.json(ApiResponse.success(saved, saved
                ? `Hospital ${hospitalId} acts as ABDM facility ${saved.hipId ?? saved.scanShareHipId ?? hiuId}${hiuId ? `, and requests records as HIU ${hiuId}` : ""}.`
                : `Hospital ${hospitalId} no longer acts as an ABDM facility.`));
        } catch (error) {
            if (error instanceof FacilityError) {
                return res.status(error instanceof FacilityClashError ? 409 : 400).json(ApiResponse.error(error.message, { kind: "invalid" }));
            }
            if ([2627, 2601].includes((error as any)?.number ?? (error as any)?.driverError?.number)) {
                return res.status(409).json(ApiResponse.error("That HIP or HIU id is already saved for another hospital.", { kind: "invalid" }));
            }
            return sendError(res, error);
        }
    }

    async requestOtp(req: Request, res: Response) {
        try {
            const result = await abhaEnrolmentService.requestAadhaarOtp({
                aadhaar: req.body?.aadhaar,
                consent: req.body?.consent,
                staffUserId: staffUserId(req),
                hospitalId: headerNumber(req, "x-hospital-id"),
                organizationId: headerNumber(req, "x-org-id"),
            });
            return res.json(ApiResponse.success(result, result.message));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async resendOtp(req: Request, res: Response) {
        try {
            const result = await abhaEnrolmentService.resendAadhaarOtp(req.body?.sessionId, staffUserId(req));
            return res.json(ApiResponse.success(result, result.message));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async verifyOtp(req: Request, res: Response) {
        try {
            const result = await abhaEnrolmentService.verifyAadhaarOtp({
                sessionId: req.body?.sessionId,
                staffUserId: staffUserId(req),
                otp: req.body?.otp,
                mobile: req.body?.mobile,
            });
            return res.json(ApiResponse.success(result, result.message));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async requestMobileOtp(req: Request, res: Response) {
        try {
            const result = await abhaEnrolmentService.requestMobileOtp(req.body?.sessionId, staffUserId(req));
            return res.json(ApiResponse.success(result, result.message));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async verifyMobileOtp(req: Request, res: Response) {
        try {
            const result = await abhaEnrolmentService.verifyMobileOtp({ sessionId: req.body?.sessionId, staffUserId: staffUserId(req), otp: req.body?.otp });
            return res.json(ApiResponse.success(result, result.message));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async addressSuggestions(req: Request, res: Response) {
        try {
            const result = await abhaEnrolmentService.getAddressSuggestions(String(req.query.sessionId ?? ""), staffUserId(req));
            return res.json(ApiResponse.success(result));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async createAddress(req: Request, res: Response) {
        try {
            const result = await abhaEnrolmentService.createAbhaAddress({
                sessionId: req.body?.sessionId,
                staffUserId: staffUserId(req),
                abhaAddress: req.body?.abhaAddress,
            });
            return res.json(ApiResponse.success(result, "ABHA address created."));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async card(req: Request, res: Response) {
        try {
            const result = await abhaEnrolmentService.getAbhaCard(String(req.query.sessionId ?? ""), staffUserId(req));
            return res.json(ApiResponse.success(result));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async linkToPatient(req: Request, res: Response) {
        try {
            const result = await abhaEnrolmentService.linkToPatient({
                sessionId: req.body?.sessionId,
                staffUserId: staffUserId(req),
                userId: String(req.params.userId ?? ""),
                hospitalId: headerNumber(req, "x-hospital-id"),
            });
            // The patient's records here link to the ABHA now too, where the hospital has AutoLink on
            autoLinker.recordSaved({ patientId: String(req.params.userId ?? ""), hospitalId: headerNumber(req, "x-hospital-id") });
            return res.json(ApiResponse.success(result, "ABHA linked to the patient record."));
        } catch (error) {
            return sendError(res, error);
        }
    }

    // --- Verify an existing ABHA, and find one by mobile ---

    async searchAbhaAddress(req: Request, res: Response) {
        try {
            const result = await abhaLoginService.searchAbhaAddress({ abhaAddress: req.body?.abhaAddress });
            return res.json(ApiResponse.success(result));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async requestLoginOtp(req: Request, res: Response) {
        try {
            const result = await abhaLoginService.requestLoginOtp({
                method: req.body?.method,
                identifier: req.body?.identifier,
                otpSystem: req.body?.otpSystem,
                staffUserId: staffUserId(req),
            });
            return res.json(ApiResponse.success(result, result.message));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async resendLoginOtp(req: Request, res: Response) {
        try {
            const result = await abhaLoginService.resendLoginOtp({ sessionId: req.body?.sessionId, staffUserId: staffUserId(req) });
            return res.json(ApiResponse.success(result, result.message));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async verifyLoginOtp(req: Request, res: Response) {
        try {
            const result = await abhaLoginService.verifyLoginOtp({ sessionId: req.body?.sessionId, staffUserId: staffUserId(req), otp: req.body?.otp });
            return res.json(ApiResponse.success(result, result.message));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async selectAccount(req: Request, res: Response) {
        try {
            const result = await abhaLoginService.selectAccount({ sessionId: req.body?.sessionId, staffUserId: staffUserId(req), abhaNumber: req.body?.abhaNumber });
            return res.json(ApiResponse.success(result, result.message));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async findByMobile(req: Request, res: Response) {
        try {
            const result = await abhaLoginService.findByMobile({ mobile: req.body?.mobile, staffUserId: staffUserId(req) });
            return res.json(ApiResponse.success(result));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async requestFindOtp(req: Request, res: Response) {
        try {
            const result = await abhaLoginService.requestFindOtp({ sessionId: req.body?.sessionId, staffUserId: staffUserId(req), index: Number(req.body?.index) });
            return res.json(ApiResponse.success(result, result.message));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async requestProfileMobileOtp(req: Request, res: Response) {
        try {
            const result = await abhaLoginService.requestProfileMobileOtp({ sessionId: req.body?.sessionId, staffUserId: staffUserId(req), mobile: req.body?.mobile });
            return res.json(ApiResponse.success(result, result.message));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async verifyProfileMobileOtp(req: Request, res: Response) {
        try {
            const result = await abhaLoginService.verifyProfileMobileOtp({ sessionId: req.body?.sessionId, staffUserId: staffUserId(req), otp: req.body?.otp });
            return res.json(ApiResponse.success(result, result.message));
        } catch (error) {
            return sendError(res, error);
        }
    }

    // --- Scan and Share at the counter ---

    async counterQr(req: Request, res: Response) {
        try {
            const facility = await abdmFacilities.byHospital(headerNumber(req, "x-hospital-id"));
            const hipId = facility ? scanShareHipIdOf(facility) : null;
            if (!hipId) {
                throw new AbhaJourneyError(503, "not-configured", "Scan and Share isn't set up for this hospital: it has no ABDM facility yet.");
            }
            const counterId = assertCounterId(req.query.counterId);
            const url = counterShareUrl(hipId, counterId);
            const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: "M" });
            return res.json(ApiResponse.success({ hipId, counterId, url, qrDataUrl }));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async shareQueue(req: Request, res: Response) {
        try {
            // Only the desk's own hospital, and only for staff who work there.
            const hospitalId = await shareQueueHospital(headerNumber(req, "x-hospital-id"), staffUserId(req), abhaRepository);
            const counterId = req.query.counterId ? String(req.query.counterId) : undefined;
            const rows = await abhaShareService.queue({ hospitalId, counterId });
            return res.json(ApiResponse.success({ hospitalId, shares: rows.map(toQueueItem) }));
        } catch (error) {
            return sendError(res, error);
        }
    }
}

/** A queue row for the desk: the ABHA number masked, the rest as recorded. */
const toQueueItem = (row: ShareRow) => ({
    id: row.id,
    createdAt: row.createdAt,
    counterId: row.counterId,
    tokenNumber: row.tokenNumber,
    expiresAt: row.expiresAt,
    patientName: row.patientName,
    abhaAddress: row.abhaAddress,
    abhaNumber: row.abhaNumber ? `xx-xxxx-xxxx-${row.abhaNumber.slice(-4)}` : null,
    userId: row.userId,
    status: row.status,
    matchType: row.matchType,
    error: row.error,
});

/**
 * ABDM's Scan and Share callback, POST /api/v3/hip/patient/share. Authenticated by ABDM's signed
 * token, not a user login. Answered with 200 as soon as it is validated; the patient is then
 * registered and ABDM gets the queue token on on-share.
 */
export const abhaShareCallback = async (req: Request, res: Response) => {
    const requestId = String(req.headers["request-id"] ?? "").trim();
    try {
        const claims = await abdmCallbackAuth.verify(req.headers.authorization);
        console.log(`[ABDM] Share callback REQUEST-ID=${requestId || "-"} from client=${claims.clientId ?? claims.azp ?? "?"}`);
    } catch (error: any) {
        console.warn(`[ABDM] Share callback refused, REQUEST-ID=${requestId || "-"}: ${error?.message}`);
        return res.status(401).json({ error: { code: "ABDM-1001", message: "Unauthorized" } });
    }
    if (!requestId) {
        return res.status(400).json({ error: { code: "ABDM-1006", message: "REQUEST-ID header is required" } });
    }

    let share;
    try {
        share = await abhaShareService.parse(req.headers["x-hip-id"], req.body);
    } catch (error: any) {
        console.warn(`[ABDM] Share REQUEST-ID=${requestId} refused: ${error?.message}`);
        const status = error instanceof AbhaJourneyError ? error.status : 400;
        return res.status(status).json({ error: { code: "ABDM-1006", message: error?.message || "Bad Request" } });
    }

    res.status(200).end();
    abhaShareService.process(requestId, share).catch((error: any) =>
        console.error(`[ABDM] Share REQUEST-ID=${requestId} could not be processed: ${error?.message}`));
};

export const abhaEnrolmentController = new AbhaEnrolmentController();
