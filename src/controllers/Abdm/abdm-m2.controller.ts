import type { Request, Response } from "express";
import { ApiResponse } from "../../utils/response.utils.js";
import { AbdmApiError, type AbdmErrorKind } from "../../services/Abdm/abdm-gateway.service.js";
import { careContextCatalog, hipLinkingService } from "../../services/Abdm/m2/index.js";
import { LinkingError } from "../../services/Abdm/m2/hip-linking.js";
import { abdmM2Repository } from "../../repositories/Abdm/abdm-m2.repository.js";
import { abdmFacilities } from "../../services/Abdm/abdm-facilities.service.js";

/**
 * Staff view of a patient's ABDM care contexts, and the two things staff can start: linking and the
 * SMS. All of it is for the hospital the staff member is working at (X-Hospital-Id), as that
 * hospital's ABDM facility.
 */

const STATUS: Record<AbdmErrorKind, number> = { rejected: 422, "not-configured": 503, timeout: 504, credentials: 502, unavailable: 502, integration: 502 };

const sendError = (res: Response, error: any) => {
    if (error instanceof LinkingError) return res.status(error.status).json(ApiResponse.error(error.message, { kind: "linking" }));
    if (error instanceof AbdmApiError) {
        return res.status(STATUS[error.kind]).json(ApiResponse.error("ABDM did not accept this request.", {
            kind: error.kind, abdmMessage: error.message, abdmCode: error.code, requestId: error.requestId,
            hint: error.kind === "rejected" ? null : "Try again in a few minutes; quote the request ID if it repeats.",
        }));
    }
    console.error("[ABDM] M2 staff action failed:", error?.message);
    return res.status(500).json(ApiResponse.error("Something went wrong while talking to ABDM.", { kind: "unexpected" }));
};

const userId = (req: Request) => String(req.params.userId);

const hospitalId = (req: Request): number | null => {
    const id = Number(req.headers["x-hospital-id"]);
    return Number.isInteger(id) && id > 0 ? id : null;
};

/** The facility the staff member's hospital acts as; refuses when it has none. */
const hipFor = async (req: Request) => {
    const hip = await abdmFacilities.hip(hospitalId(req));
    if (!hip) throw new LinkingError("This hospital is not set up as an ABDM facility yet.", 409);
    return hip;
};

export class AbdmM2Controller {
    async careContexts(req: Request, res: Response) {
        try {
            const patient = await abdmM2Repository.patient(userId(req));
            if (!patient) return res.status(404).json(ApiResponse.error("Patient not found."));
            const hip = await abdmFacilities.hip(hospitalId(req));
            const contexts = hip ? await careContextCatalog.refresh(hip, patient.userId) : [];
            return res.json(ApiResponse.success({
                patient: { hasAbha: Boolean(patient.abhaAddress), abhaAddress: patient.abhaAddress, abhaNumber: patient.abhaNumber, phone: patient.phone },
                hip: hip ? { id: hip.id, name: hip.name, hospitalId: hip.hospitalId } : null,
                careContexts: contexts.map((c) => ({
                    referenceNumber: c.referenceNumber,
                    kind: c.kind,
                    sourceId: c.sourceId,
                    date: c.recordDate.toISOString(),
                    display: c.display,
                    hiTypes: c.hiTypes,
                    linkStatus: c.linkStatus,
                    linkedAt: c.linkedAt?.toISOString() ?? null,
                    lastError: c.lastError,
                })),
            }));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async link(req: Request, res: Response) {
        try {
            return res.json(ApiResponse.success(await hipLinkingService.link(await hipFor(req), userId(req)), "Linking started."));
        } catch (error) {
            return sendError(res, error);
        }
    }

    async smsNotify(req: Request, res: Response) {
        try {
            return res.json(ApiResponse.success(await hipLinkingService.smsNotify(await hipFor(req), userId(req)), "ABDM was asked to text the patient."));
        } catch (error) {
            return sendError(res, error);
        }
    }
}

export const abdmM2Controller = new AbdmM2Controller();
