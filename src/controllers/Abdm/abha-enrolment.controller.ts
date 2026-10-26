import type { Request, Response } from "express";
import { ApiResponse } from "../../utils/response.utils.js";
import { abdmConfig } from "../../config/abdm.config.js";
import { AbdmApiError, type AbdmErrorKind } from "../../services/Abdm/abdm-gateway.service.js";
import { AbhaEnrolmentService, AbhaJourneyError } from "../../services/Abdm/abha-enrolment.service.js";
import { abhaRepository } from "../../repositories/Abdm/abha.repository.js";

const abhaEnrolmentService = new AbhaEnrolmentService(abhaRepository);

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
            });
            return res.json(ApiResponse.success(result, "ABHA linked to the patient record."));
        } catch (error) {
            return sendError(res, error);
        }
    }
}

export const abhaEnrolmentController = new AbhaEnrolmentController();
