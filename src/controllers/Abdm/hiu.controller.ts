import type { Request, Response } from "express";
import { ApiResponse } from "../../utils/response.utils.js";
import { AbdmApiError, type AbdmErrorKind } from "../../services/Abdm/abdm-gateway.service.js";
import { HiuError, hiuNotConfiguredError } from "../../services/Abdm/hiu/hiu-enums.js";
import { ConsentInitUnansweredError, HiuConsentService, type NewConsentRequestInput, type StaffContext } from "../../services/Abdm/hiu/hiu-consent.service.js";
import { HiuDataFlowService } from "../../services/Abdm/hiu/hiu-data-flow.service.js";
import { HiuMaintenanceService } from "../../services/Abdm/hiu/hiu-maintenance.service.js";
import { hiuStaffContext } from "../../middlewares/abdm-hiu-access.middleware.js";

/**
 * The HIU staff API, /api/abdm/hiu (M3: ClinicX as a Health Information User), behind
 * staffJwtMiddleware and abdmHiuAccess. Every response carries Cache-Control: no-store, and every
 * call works on the hospital the access guard verified, never on one the browser names in a body.
 *
 * The services and their repositories are built on first use (hiuServices), so this module and
 * its tests load without a database; index.ts starts the maintenance sweep through the same wiring.
 */

// ---------------------------------------------------------------------------------------------
// Wiring

export interface HiuServices {
    consent: HiuConsentService;
    dataFlow: HiuDataFlowService;
    maintenance: HiuMaintenanceService;
}

let wiring: Promise<HiuServices> | null = null;

/** The one set of HIU services: repositories, audit, data flow, consent (with its requester) and maintenance. */
export const hiuServices = (): Promise<HiuServices> => {
    if (!wiring) {
        wiring = (async () => {
            const [{ hiuConsentRepository }, { hiuDataRepository }, { hiuAuditRepository }] = await Promise.all([
                import("../../repositories/Abdm/hiu-consent.repository.js"),
                import("../../repositories/Abdm/hiu-data.repository.js"),
                import("../../repositories/Abdm/hiu-audit.repository.js"),
            ]);
            const dataFlow = new HiuDataFlowService({ store: hiuDataRepository, audit: hiuAuditRepository });
            const consent = new HiuConsentService(hiuConsentRepository, { audit: hiuAuditRepository });
            consent.setRequester(dataFlow);
            const maintenance = new HiuMaintenanceService({ store: hiuDataRepository, dataFlow, consent, audit: hiuAuditRepository });
            return { consent, dataFlow, maintenance };
        })();
        wiring.catch(() => {
            wiring = null;
        });
    }
    return wiring;
};

/** Starts the HIU housekeeping sweep (purge, timeouts, key deletion) once a minute. Returns its stop function. */
export const startHiuMaintenance = async (): Promise<() => void> => (await hiuServices()).maintenance.start();

// ---------------------------------------------------------------------------------------------
// Errors

/**
 * The top-level message of an ABDM failure; ABDM's own words go in data.abdmMessage. The frontend's
 * HTTP client treats any error message containing "expired" as its own login lapsing.
 */
const ABDM_SUMMARIES: Record<AbdmErrorKind, string> = {
    credentials: "ABDM refused the clinic's ABDM credentials.",
    rejected: "ABDM did not accept this request.",
    timeout: "ABDM did not reply in time.",
    unavailable: "ABDM is not responding properly.",
    "not-configured": "ABDM record requests aren't set up for this clinic yet.",
    integration: "ABDM record requests can't be used because of a setup problem.",
};

/** Added to the message when a consent init got no answer (ConsentInitUnansweredError). */
const UNANSWERED_NOTE = "The request may still have been sent: check the list before raising it again.";

/** ABDM's 401 is never passed on as 401: the app would take it for its own login lapsing. */
const abdmStatus = (kind: AbdmErrorKind): number => {
    switch (kind) {
        case "rejected": return 422;
        case "not-configured": return 503;
        case "timeout": return 504;
        default: return 502;
    }
};

const safeMessage = (message: string): string => message.replace(/expired/gi, "lapsed");

/** Maps a thrown error to the staff API's error answer (contract: Staff API errors). */
export const sendHiuError = (res: Response, error: any) => {
    if (error instanceof HiuError) {
        return res.status(error.status).json(ApiResponse.error(safeMessage(error.message), { kind: error.kind, ...error.details }));
    }
    if (error instanceof AbdmApiError) {
        // A consent init with no answer: the request is stored and may have reached ABDM after all.
        const unanswered = error instanceof ConsentInitUnansweredError
            ? { kind: error.kind, mayHaveBeenSent: true, id: error.id, initRequestId: error.initRequestId }
            : null;
        return res.status(abdmStatus(error.kind)).json(ApiResponse.error(
            unanswered ? `${ABDM_SUMMARIES[error.kind]} ${UNANSWERED_NOTE}` : ABDM_SUMMARIES[error.kind],
            {
                kind: error.kind === "not-configured" ? "not-configured" : "abdm",
                abdmKind: error.kind,
                abdmCode: error.code,
                abdmMessage: error.message,
                field: error.field,
                requestId: error.requestId,
                ...unanswered,
            },
        ));
    }
    console.error(`[ABDM HIU] unexpected error in the staff API: ${error?.code ?? error?.name ?? "error"}`);
    return res.status(500).json(ApiResponse.error("Something went wrong with the ABDM record request. Try again.", { kind: "unexpected" }));
};

// ---------------------------------------------------------------------------------------------
// Handlers

export type HiuStaffServices = {
    consent: Pick<HiuConsentService, "options" | "patientAbha" | "create" | "list" | "detail" | "refreshStatus">;
    dataFlow: Pick<HiuDataFlowService, "records" | "record" | "requestRecords">;
};

type Handler = (req: Request, res: Response) => Promise<unknown>;

const positiveInt = (value: unknown): number => {
    const text = String(value ?? "").trim();
    return /^\d{1,9}$/.test(text) ? Number(text) : 0;
};

const queryText = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** The fields of a new consent request; anything else in the body (an ABHA address, a hospital) is ignored. */
const newRequestInput = (body: any): NewConsentRequestInput => ({
    patientUserId: body?.patientUserId,
    purposeCode: body?.purposeCode,
    hiTypes: body?.hiTypes,
    dateFrom: body?.dateFrom,
    dateTo: body?.dateTo,
    dataEraseAt: body?.dataEraseAt,
    accessMode: body?.accessMode,
});

/**
 * The staff API's handlers over [services]. Every handler but options answers 503 not-configured,
 * before any work, while the server cannot act as an HIU or the hospital has no HIU id (plan D1;
 * the message says which).
 */
export const createHiuController = (services: () => Promise<HiuStaffServices> = hiuServices) => {
    const handle = (work: (s: HiuStaffServices, ctx: StaffContext, req: Request, res: Response) => Promise<unknown>, gate = true): Handler =>
        async (req, res) => {
            res.setHeader("Cache-Control", "no-store");
            try {
                const ctx = hiuStaffContext(req);
                if (!ctx) throw new HiuError("forbidden", "Your access to ABDM record requests could not be confirmed.");
                const s = await services();
                if (gate) {
                    const options = await s.consent.options(ctx);
                    if (!options.configured) throw options.reason ? new HiuError("not-configured", options.reason) : hiuNotConfiguredError();
                }
                return await work(s, ctx, req, res);
            } catch (error) {
                return sendHiuError(res, error);
            }
        };

    return {
        options: handle(async (s, ctx, _req, res) => res.json(ApiResponse.success(await s.consent.options(ctx))), false),

        patientAbha: handle(async (s, ctx, req, res) =>
            res.json(ApiResponse.success(await s.consent.patientAbha(ctx, String(req.params.userId ?? ""))))),

        create: handle(async (s, ctx, req, res) =>
            res.status(202).json(ApiResponse.success(await s.consent.create(ctx, newRequestInput(req.body)), "Record request sent to ABDM. The patient answers it in their ABHA app."))),

        list: handle(async (s, ctx, req, res) => {
            const status = queryText(req.query.status);
            const result = await s.consent.list(ctx, {
                page: positiveInt(req.query.page) || 1,
                pageSize: positiveInt(req.query.pageSize) || 20,
                ...(status ? { status } : {}),
            });
            return res.json(ApiResponse.success(result));
        }),

        detail: handle(async (s, ctx, req, res) =>
            res.json(ApiResponse.success(await s.consent.detail(ctx, positiveInt(req.params.id))))),

        refreshStatus: handle(async (s, ctx, req, res) =>
            res.json(ApiResponse.success(await s.consent.refreshStatus(ctx, positiveInt(req.params.id)), "Status asked of ABDM. The answer arrives in a moment."))),

        records: handle(async (s, ctx, req, res) =>
            res.json(ApiResponse.success(await s.dataFlow.records(ctx, positiveInt(req.params.id))))),

        /** One record with its content, for a record the list returned without it (contentOmitted). */
        record: handle(async (s, ctx, req, res) =>
            res.json(ApiResponse.success(await s.dataFlow.record(ctx, positiveInt(req.params.id), positiveInt(req.params.recordId))))),

        /** Asks for an artefact's records again, after a failed transfer or a request that never went out. */
        requestRecords: handle(async (s, ctx, req, res) =>
            res.status(202).json(ApiResponse.success(await s.dataFlow.requestRecords(ctx, positiveInt(req.params.id)), "Records asked for again. They arrive once the provider sends them."))),
    };
};

export const hiuController = createHiuController();
