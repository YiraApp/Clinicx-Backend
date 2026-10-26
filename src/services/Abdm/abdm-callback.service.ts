import { abdmConfig } from "../../config/abdm.config.js";
import { maskCredentials } from "../../utils/log-mask.utils.js";
import { abdmCallbackAuth, CallbackAuthError, type AbdmCallbackAuth } from "./abdm-callback-auth.service.js";

/**
 * Every M2 request ABDM posts to this HIP's bridge (/api/v3/...). Nothing is read for action
 * until three checks pass, failing closed (ABDM: "Proving a callback really came from ABDM",
 * /docs/hiecm/v3/concepts/callback-authenticity):
 *   1. the bearer token is ABDM's: AbdmCallbackAuth, shared with Scan and Share, verifies its
 *      signature against the gateway's published keys, its expiry, and that it was issued to a
 *      client in ABDM_CALLBACK_CLIENT_IDS;
 *   2. X-HIP-ID names this HIP;
 *   3. an answer's response.requestId matches a REQUEST-ID this system sent and has not had answered.
 * A callback that passes is stored whole (credentials masked) before anything parses it, then
 * acknowledged with 202; handling it is the next steps' work.
 */

/** Callbacks that answer a call this HIP made, matched on response.requestId. */
export const ANSWER_PATHS = [
    "/api/v3/hip/token/on-generate-token",
    "/api/v3/link/on_carecontext",
    "/api/v3/links/context/on-notify",
    "/api/v3/patients/sms/on-notify",
] as const;

/** Requests ABDM makes of this HIP, which answer nothing and are keyed by their own REQUEST-ID. */
export const REQUEST_PATHS = [
    "/api/v3/hip/patient/care-context/discover",
    "/api/v3/hip/link/care-context/init",
    "/api/v3/hip/link/care-context/confirm",
    "/api/v3/consent/request/hip/notify",
    "/api/v3/hip/health-information/request",
] as const;

export interface StoredCallback {
    path: string;
    /** The callback's own REQUEST-ID header. */
    requestId: string;
    hipId: string;
    /** JSON: header name to value length. */
    headers: string;
    /** JSON, credentials masked. */
    body: string;
    receivedAt: Date;
}

export interface CallbackStore {
    /** Closes the outbound exchange answeredRequestId names, if it is still waiting. */
    answer(answeredRequestId: string, callback: StoredCallback): Promise<"answered" | "duplicate" | "unknown">;
    /** Stores a request ABDM made; a redelivery of one already stored is a duplicate. */
    receive(callback: StoredCallback): Promise<"stored" | "duplicate">;
}

export interface CallbackOutcome {
    status: number;
    /** Why, for the log and for a refusal's body. */
    reason: string;
}

type Headers = Record<string, string | string[] | undefined>;

const header = (headers: Headers, name: string): string => {
    const value = headers[name];
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
};

/** Header names and value lengths: the name is the finding, the value may be a credential. */
const headerShape = (headers: Headers): string =>
    JSON.stringify(Object.fromEntries(Object.entries(headers).map(([name, value]) =>
        [name, Array.isArray(value) ? value.join(",").length : (value ?? "").length])));

export class AbdmCallbackService {
    constructor(
        private readonly store: CallbackStore,
        private readonly auth: Pick<AbdmCallbackAuth, "verify"> = abdmCallbackAuth,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async receive(input: { path: string; headers: Headers; body: unknown }): Promise<CallbackOutcome> {
        const path = input.path.split("?")[0]!.replace(/\/+$/, "");
        const isAnswer = (ANSWER_PATHS as readonly string[]).includes(path);
        const isRequest = (REQUEST_PATHS as readonly string[]).includes(path);
        if (!isAnswer && !isRequest) {
            return this.refuse(path, 404, "not an ABDM callback this HIP serves");
        }

        try {
            await this.auth.verify(header(input.headers, "authorization") || undefined);
        } catch (error) {
            // Anything else (the gateway's keys could not be fetched) is thrown: nothing is stored,
            // and a 5xx lets ABDM deliver it again.
            if (!(error instanceof CallbackAuthError)) throw error;
            return this.refuse(path, 401, error.message);
        }

        const hipId = header(input.headers, "x-hip-id");
        const ourHip = abdmConfig.m2HipId;
        if (!ourHip || hipId !== ourHip) {
            // On a shared bridge another facility's callbacks can arrive here: never store or act on them.
            return this.refuse(path, 403, `X-HIP-ID ${hipId || "(none)"} is not this HIP`);
        }

        const requestId = header(input.headers, "request-id");
        if (!requestId) {
            return this.refuse(path, 400, "no REQUEST-ID header");
        }
        if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
            return this.refuse(path, 400, "no JSON body");
        }

        const callback: StoredCallback = {
            path,
            requestId,
            hipId,
            headers: headerShape(input.headers),
            body: JSON.stringify(maskCredentials(input.body)),
            receivedAt: this.now(),
        };

        if (isAnswer) {
            const answered = (input.body as any)?.response?.requestId;
            if (typeof answered !== "string" || !answered.trim()) {
                return this.refuse(path, 400, "answers no request: response.requestId is missing");
            }
            const result = await this.store.answer(answered.trim(), callback);
            if (result === "unknown") return this.refuse(path, 400, `answers ${answered}, which this system did not send or is not waiting on`);
            if (result === "duplicate") return this.refuse(path, 409, `${answered} was already answered`);
            return this.accept(path, requestId, `answers ${answered}`);
        }

        const result = await this.store.receive(callback);
        return this.accept(path, requestId, result === "duplicate" ? "redelivery, already stored" : "stored");
    }

    private accept(path: string, requestId: string, reason: string): CallbackOutcome {
        console.log(`[ABDM] callback ${path} REQUEST-ID=${requestId} -> 202 (${reason})`);
        return { status: 202, reason };
    }

    private refuse(path: string, status: number, reason: string): CallbackOutcome {
        console.warn(`[ABDM] callback ${path} refused ${status}: ${reason}`);
        return { status, reason };
    }
}
