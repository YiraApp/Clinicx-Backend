import type { NextFunction, Request, Response } from "express";
import { abdmCallbackAuth, type AbdmCallbackAuth } from "../../services/Abdm/abdm-callback-auth.service.js";
import { abdmFacilities, type AbdmFacilityDirectory } from "../../services/Abdm/abdm-facilities.service.js";
import type { CallbackHeaders, HiuConsentService } from "../../services/Abdm/hiu/hiu-consent.service.js";
import type { HiuDataFlowService } from "../../services/Abdm/hiu/hiu-data-flow.service.js";
import { hiuServices } from "./hiu.controller.js";

/**
 * ABDM's callbacks to this HIU, mounted at /api/v3/hiu before the user-login middleware, and the
 * HIPs' data push (POST /api/v3/hiu/data-push/:pushToken).
 *
 * Gateway callbacks: the bearer must be ABDM's gateway token (signature, expiry and the client
 * pin), REQUEST-ID must be present, and X-HIU-ID, which the spec sends on all five, must name the
 * HIU of one of this deployment's hospitals (AbdmFacilities). Then the callback is answered 200 {}
 * at once and handed to its service without waiting: the services match it to our stored
 * REQUEST-ID, take it only when that request was raised as the same HIU, and never throw.
 *
 * Data push: the bearer is the HIP's own gateway token, so its signature and expiry are checked
 * without the gateway client pin. Any ABDM client can hold such a token, so the push token in the
 * URL (an open transfer, inside its window) is checked next, still before the body is read; then
 * acceptPush checks everything again with the body, and its status is the answer (202 when the
 * page was taken).
 *
 * Logs carry a structural summary only (keys, array lengths, ids and statuses), never content,
 * ABHA addresses, care-context references, keys, nonces or tokens.
 */

export type HiuCallbackServices = {
    consent: Pick<HiuConsentService, "onInit" | "onStatus" | "notify" | "onFetch">;
    dataFlow: Pick<HiuDataFlowService, "onRequest" | "acceptPush" | "pushAddressProblem">;
};

export interface HiuCallbackDeps {
    auth: Pick<AbdmCallbackAuth, "verify">;
    services: () => Promise<HiuCallbackServices>;
    /** The hospitals' HIUs: a callback whose X-HIU-ID names none of them is refused. */
    directory: Pick<AbdmFacilityDirectory, "hiuById">;
}

const header = (req: Request, name: string): string | null => {
    const value = req.headers[name];
    const text = String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
    return text || null;
};

const UNAUTHORIZED = { error: { code: "ABDM-1001", message: "Unauthorized" } };
const badRequest = (message: string) => ({ error: { code: "ABDM-1006", message } });

// ---------------------------------------------------------------------------------------------
// Redacted summaries for the log

/** Only these paths are printed with their values: ids and statuses, never patient data. */
const LOGGED_VALUES = [
    "response.requestId",
    "consentRequest.id",
    "consentRequest.status",
    "notification.consentRequestId",
    "notification.status",
    "consent.status",
    "consent.consentDetail.consentId",
    "hiRequest.transactionId",
    "hiRequest.sessionStatus",
    "error.code",
    "transactionId",
    "pageNumber",
    "pageCount",
];

const safeKey = (key: string): string => key.replace(/[^A-Za-z0-9_]/g, "?").slice(0, 40);
const safeValue = (value: unknown): string => String(value).replace(/[^A-Za-z0-9_\-:.]/g, "").slice(0, 64);

const shapeOf = (value: unknown, depth: number): string => {
    if (Array.isArray(value)) return `[${value.length}]`;
    if (!value || typeof value !== "object") return "";
    if (depth >= 3) return "{…}";
    const keys = Object.keys(value);
    const shown = keys.slice(0, 20).map((key) => `${safeKey(key)}${shapeOf((value as any)[key], depth + 1)}`);
    if (keys.length > 20) shown.push(`+${keys.length - 20}`);
    return `{${shown.join(",")}}`;
};

const valueAt = (body: any, path: string): unknown =>
    path.split(".").reduce((node, key) => (node && typeof node === "object" && !Array.isArray(node) ? node[key] : undefined), body);

/** A callback or push body as the log may show it: its structure plus whitelisted ids and statuses. */
export const callbackSummary = (body: unknown): string => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return Array.isArray(body) ? `array[${body.length}]` : typeof body;
    const values = LOGGED_VALUES
        .map((path) => [path, valueAt(body, path)] as const)
        .filter(([, value]) => typeof value === "string" || typeof value === "number")
        .map(([path, value]) => `${path}=${safeValue(value)}`);
    return `${shapeOf(body, 0)}${values.length ? ` ${values.join(" ")}` : ""}`;
};

// ---------------------------------------------------------------------------------------------
// Handlers

type CallbackName = "on-init" | "on-status" | "notify" | "on-fetch" | "on-request";

const dispatch = (services: HiuCallbackServices, name: CallbackName, body: any, headers: CallbackHeaders): Promise<void> => {
    switch (name) {
        case "on-init": return services.consent.onInit(body, headers);
        case "on-status": return services.consent.onStatus(body, headers);
        case "notify": return services.consent.notify(body, headers);
        case "on-fetch": return services.consent.onFetch(body, headers);
        case "on-request": return services.dataFlow.onRequest(body, headers);
    }
};

const defaultDeps: HiuCallbackDeps = {
    auth: abdmCallbackAuth,
    services: hiuServices,
    directory: abdmFacilities,
};

export const createHiuCallbackController = (deps: HiuCallbackDeps = defaultDeps) => {
    const callback = (name: CallbackName) => async (req: Request, res: Response) => {
        const requestId = header(req, "request-id");
        const label = `[ABDM HIU] ${name} REQUEST-ID=${requestId ? safeValue(requestId) : "-"}`;

        let caller = "?";
        try {
            const claims = await deps.auth.verify(req.headers.authorization);
            caller = safeValue(claims.clientId ?? claims.azp ?? "?");
        } catch (error: any) {
            console.warn(`${label} refused: ${error?.message}`);
            return res.status(401).json(UNAUTHORIZED);
        }
        if (!requestId) {
            return res.status(400).json(badRequest("REQUEST-ID header is required"));
        }
        const hiuId = header(req, "x-hiu-id");
        let hiu;
        try {
            hiu = hiuId ? await deps.directory.hiuById(hiuId) : null;
        } catch (error: any) {
            console.error(`${label} X-HIU-ID could not be checked: ${error?.code ?? error?.name ?? "error"}`);
            return res.status(500).json({ error: { code: "500", message: "The callback could not be taken. Send it again." } });
        }
        if (!hiu) {
            console.warn(`${label} refused: X-HIU-ID ${hiuId ? `${safeValue(hiuId)} is no hospital's HIU here` : "is missing"}`);
            return res.status(400).json(badRequest("X-HIU-ID does not name this HIU"));
        }
        const body = req.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return res.status(400).json(badRequest("The body must be a JSON object"));
        }

        console.log(`${label} from client=${caller}: ${callbackSummary(body)}`);
        res.status(200).json({});

        const headers: CallbackHeaders = { requestId, hiuId, timestamp: header(req, "timestamp") };
        void (async () => dispatch(await deps.services(), name, body, headers))().catch((error: any) =>
            console.error(`${label} could not be processed: ${error?.code ?? error?.name ?? "error"}`));
    };

    /**
     * The data push's bearer check, run before its body is read: a gateway-signed, unexpired token
     * from any ABDM client (no pin). It keeps out callers outside ABDM, not other ABDM clients.
     */
    const dataPushAuth = async (req: Request, res: Response, next: NextFunction) => {
        try {
            await deps.auth.verify(req.headers.authorization, { pinClient: false });
        } catch (error: any) {
            console.warn(`[ABDM HIU] data push refused: ${error?.message}`);
            return res.status(401).json(UNAUTHORIZED);
        }
        next();
    };

    /**
     * The push token check, also before the body is read, so only the HIP holding the address of an
     * open transfer can make us read and parse megabytes. A refusal closes the connection rather
     * than draining the unread body.
     */
    const dataPushAddress = async (req: Request, res: Response, next: NextFunction) => {
        let answer;
        try {
            answer = await (await deps.services()).dataFlow.pushAddressProblem(String(req.params.pushToken ?? ""));
        } catch (error: any) {
            console.error(`[ABDM HIU] data push address check failed: ${error?.code ?? error?.name ?? "error"}`);
            res.setHeader("Connection", "close");
            return res.status(500).json({ error: { code: "500", message: "The page could not be taken. Send it again." } });
        }
        if (!answer) return next();
        console.log(`[ABDM HIU] data push ${answer.status} before the body was read`);
        const status = answer.status >= 400 && answer.status < 600 ? answer.status : 400;
        res.setHeader("Connection", "close");
        return res.status(status).json({ error: { code: String(status), message: answer.reason ?? "Refused" } });
    };

    /** The page itself, after dataPushAuth and the push route's own JSON parser. */
    const dataPush = async (req: Request, res: Response) => {
        const transfer = req.body && typeof req.body === "object" ? callbackSummary(req.body) : typeof req.body;
        try {
            const answer = await (await deps.services()).dataFlow.acceptPush(String(req.params.pushToken ?? ""), req.body);
            console.log(`[ABDM HIU] data push ${answer.status}${answer.accepted ? " accepted" : ""}: ${transfer}`);
            if (answer.accepted) return res.status(202).end();
            const status = answer.status >= 400 && answer.status < 600 ? answer.status : 400;
            return res.status(status).json({ error: { code: String(status), message: answer.reason ?? "Refused" } });
        } catch (error: any) {
            console.error(`[ABDM HIU] data push failed: ${error?.code ?? error?.name ?? "error"}`);
            return res.status(500).json({ error: { code: "500", message: "The page could not be taken. Send it again." } });
        }
    };

    return {
        onInit: callback("on-init"),
        onStatus: callback("on-status"),
        notify: callback("notify"),
        onFetch: callback("on-fetch"),
        onRequest: callback("on-request"),
        dataPushAuth,
        dataPushAddress,
        dataPush,
    };
};

export const hiuCallbackController = createHiuCallbackController();
