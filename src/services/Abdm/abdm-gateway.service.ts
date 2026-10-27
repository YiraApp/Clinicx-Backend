import { randomUUID } from "crypto";
import { abdmConfig } from "../../config/abdm.config.js";

/**
 * Every call this system makes to ABDM goes through here: the gateway session token,
 * the headers each call carries, and one error type for ABDM's several error shapes.
 * Logs carry the method, path, REQUEST-ID, status and duration, never a body or a token.
 */

export type AbdmErrorKind =
    | "credentials"      // ABDM refused the clinic's client id/secret or token
    | "rejected"         // ABDM refused the request itself; its message says why
    | "timeout"          // no answer inside the request timeout
    | "unavailable"      // ABDM could not be reached, or failed on its side
    | "not-configured"   // ABDM credentials are not set for this deployment
    | "integration";     // a problem on our side, such as an unknown encryption algorithm

export class AbdmApiError extends Error {
    /** HTTP status ABDM answered with; 0 when it never answered. */
    readonly status: number;
    /** ABDM error code without any trailing ": ", when ABDM gave one. */
    readonly code: string | null;
    /** The request field ABDM named, when it named one. */
    readonly field: string | null;
    readonly kind: AbdmErrorKind;
    readonly requestId: string | null;
    readonly operation: string;

    constructor(init: {
        status: number;
        kind: AbdmErrorKind;
        message: string;
        operation: string;
        code?: string | null;
        field?: string | null;
        requestId?: string | null;
    }) {
        super(init.message);
        this.name = "AbdmApiError";
        this.status = init.status;
        this.kind = init.kind;
        this.operation = init.operation;
        this.code = init.code ?? null;
        this.field = init.field ?? null;
        this.requestId = init.requestId ?? null;
    }
}

/**
 * True when a call failed without any answer from ABDM (our timeout, or the connection dropped), so
 * ABDM may still have accepted it and its callback may still come. Every other failure is a definite
 * answer: the call was refused or never sent.
 */
export const isOutcomeUnknown = (error: unknown): boolean =>
    error instanceof AbdmApiError && (error.kind === "timeout" || (error.kind === "unavailable" && error.status === 0));

/** ABDM codes come back bare ("ABDM-1204") or with a trailing ": " ("ABDM-1204: "). */
export const normalizeAbdmCode = (code: unknown): string | null => {
    if (code === undefined || code === null) return null;
    const text = String(code).replace(/:\s*$/, "").trim();
    return text.length > 0 ? text : null;
};

/** TIMESTAMP header: UTC, ISO-8601, with milliseconds and a trailing Z. */
export const abdmTimestamp = (date: Date = new Date()): string => date.toISOString();

/**
 * Reads the error shapes ABDM answers with:
 *   { error: { code, message } }          business and UIDAI refusals (also wrapped in an array)
 *   { code, message, description }        gateway authentication
 *   { message, timestamp }                generic
 *   { txnId, description }                a wrong OTP on enrollment/auth/byAbdm
 *   { <field>: "<message>", timestamp }   request validation, naming the field
 *   an empty body
 */
export const parseAbdmError = (status: number, body: unknown): { code: string | null; message: string; field: string | null } => {
    const fallback = `ABDM answered with HTTP ${status} and no message.`;

    if (!body || typeof body !== "object") {
        const text = typeof body === "string" ? body.trim() : "";
        return { code: null, message: text ? text.slice(0, 300) : fallback, field: null };
    }

    const b = (Array.isArray(body) ? body[0] ?? {} : body) as Record<string, any>;
    if (b.error && typeof b.error === "object") {
        return { code: normalizeAbdmCode(b.error.code), message: String(b.error.message || fallback), field: null };
    }
    if (typeof b.message === "string" || b.code !== undefined) {
        return { code: normalizeAbdmCode(b.code), message: String(b.message || b.description || fallback), field: null };
    }
    if (typeof b.description === "string" && b.description.trim()) {
        return { code: null, message: b.description.trim(), field: null };
    }

    // A transaction id is an identifier, never the message naming what was refused, but the ABHA
    // service refuses a transaction in that same field ({"txnId": "Invalid Transaction Id"}): a txnId
    // holding words is the message.
    const field = Object.keys(b).find((key) => key !== "timestamp" && typeof b[key] === "string" && (key !== "txnId" || /\s/.test(b[key])));
    if (field) {
        return { code: null, message: String(b[field]), field };
    }
    return { code: null, message: fallback, field: null };
};

const kindFor = (status: number, code: string | null, message: string): AbdmErrorKind => {
    // 9009xx come from ABDM's API manager: the client or its token was refused.
    if (code && /^9009\d\d$/.test(code)) return "credentials";
    // An ABDM business code (such as ABDM-1017, Invalid Transaction Id) refuses the journey, not the clinic.
    if (code && /^ABDM-\d+$/i.test(code)) return status >= 500 ? "unavailable" : "rejected";
    if (status === 401 || status === 403) {
        // An expired or wrong user token is the journey's problem, not the clinic's credentials.
        return /[xtr]-token/i.test(message) ? "rejected" : "credentials";
    }
    if (status >= 500) return "unavailable";
    return "rejected";
};

/** Long digit runs (a mobile or Aadhaar echoed back) never reach the log in full. */
const redactDigits = (text: string): string =>
    text.replace(/\d{6,}/g, (digits) => `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`);

export const abdmNotConfiguredError = (operation: string): AbdmApiError =>
    new AbdmApiError({
        status: 0,
        kind: "not-configured",
        operation,
        message: "ABHA isn't set up for this clinic yet: the ABDM client id and secret are missing.",
    });

export interface AbdmCall {
    /** Short name for logs, such as "enrollment/request/otp". */
    operation: string;
    method: "GET" | "POST" | "PATCH";
    /**
     * The ABHA service (M1, default) or the HIE-CM gateway (Scan and Share, bridge, certs, M2),
     * which also gets X-CM-ID.
     */
    host?: "abha" | "gateway";
    /** Path on that host, such as /abha/api/v3/... or /api/hiecm/... */
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    /** The answer is a file (the ABHA card), not JSON. */
    binary?: boolean;
    /**
     * The REQUEST-ID to send, when the caller must store it before the call because the answering
     * callback quotes it (HIU consent and data-flow calls, M2 linking). A fresh UUID otherwise.
     */
    requestId?: string;
    /**
     * ABDM answers this call later on a callback (M2's link token, linking and notify calls).
     * The exchange is recorded before the call is sent, so a callback can never arrive first.
     */
    awaitsCallback?: boolean;
}

/** Where calls that ABDM answers on a callback are recorded; see AbdmExchange. */
export interface ExchangeRecorder {
    sent(exchange: { requestId: string; operation: string; hipId: string | null }): Promise<void>;
    /** The synchronous outcome: accepted (2xx), or refused with ABDM's status and error. */
    settled(requestId: string, outcome: { state: "accepted" | "refused"; httpStatus: number; errorCode?: string | null; errorMessage?: string | null }): Promise<void>;
}

export interface AbdmFile {
    contentType: string;
    data: Buffer;
}

interface SendRequest {
    operation: string;
    url: string;
    method: "GET" | "POST" | "PATCH";
    headers: Record<string, string>;
    body?: unknown;
    binary?: boolean;
    /** Use this REQUEST-ID instead of a fresh one: the exchange was recorded under it. */
    requestId?: string;
    /** Told the HTTP status as soon as ABDM answers. */
    onStatus?: (status: number) => void;
}

export class AbdmGatewayService {
    private session: { token: string; expiresAt: number } | null = null;
    private pendingSession: Promise<string> | null = null;
    private readonly clock: () => number;
    private recorder: ExchangeRecorder | null;

    constructor(clock: () => number = Date.now, recorder: ExchangeRecorder | null = null) {
        this.clock = clock;
        this.recorder = recorder;
    }

    /** Set at startup, once the database is up. */
    setExchangeRecorder(recorder: ExchangeRecorder): void {
        this.recorder = recorder;
    }

    /** The gateway access token, renewed a minute before ABDM says it expires. */
    async getAccessToken(): Promise<string> {
        if (this.session && this.clock() < this.session.expiresAt) {
            return this.session.token;
        }
        if (!this.pendingSession) {
            this.pendingSession = this.createSession().finally(() => {
                this.pendingSession = null;
            });
        }
        return this.pendingSession;
    }

    clearAccessToken(): void {
        this.session = null;
    }

    /**
     * One call to the ABHA service, or to the gateway, with the gateway token. A credentials
     * refusal clears the cached token so the next call starts a new session; it is never retried
     * here, because a credential check must not loop.
     */
    async call<T = any>(call: AbdmCall): Promise<T> {
        const token = await this.getAccessToken();
        const toGateway = call.host === "gateway";
        const requestId = call.awaitsCallback ? await this.recordBeforeSending(call) : call.requestId;
        let httpStatus = 0;
        try {
            const result = await this.send({
                operation: call.operation,
                url: `${toGateway ? abdmConfig.gatewayBaseUrl : abdmConfig.abhaBaseUrl}${call.path}`,
                method: call.method,
                headers: { Authorization: `Bearer ${token}`, ...(toGateway ? { "X-CM-ID": abdmConfig.cmId } : {}), ...call.headers },
                body: call.body,
                binary: call.binary,
                requestId,
                onStatus: (status) => { httpStatus = status; },
            });
            if (requestId && call.awaitsCallback) await this.settle(requestId, { state: "accepted", httpStatus });
            return result;
        } catch (error) {
            if (error instanceof AbdmApiError && error.kind === "credentials") {
                this.clearAccessToken();
            }
            // A refusal ABDM answered means nothing is pending. A timeout or a lost connection
            // may still have been accepted, so its exchange stays "sent" and a callback can close it.
            if (requestId && call.awaitsCallback && error instanceof AbdmApiError && error.status > 0) {
                await this.settle(requestId, { state: "refused", httpStatus: error.status, errorCode: error.code, errorMessage: error.message });
            }
            throw error;
        }
    }

    /** Fails closed: a call whose answer could not be matched is never sent. */
    private async recordBeforeSending(call: AbdmCall): Promise<string> {
        if (!this.recorder) {
            throw new AbdmApiError({ status: 0, kind: "integration", operation: call.operation, message: "ABDM exchanges can't be recorded, so a call answered on a callback was not sent." });
        }
        const requestId = call.requestId ?? randomUUID();
        await this.recorder.sent({ requestId, operation: call.path, hipId: call.headers?.["X-HIP-ID"] ?? null });
        return requestId;
    }

    private async settle(requestId: string, outcome: Parameters<ExchangeRecorder["settled"]>[1]): Promise<void> {
        try {
            await this.recorder?.settled(requestId, outcome);
        } catch (error: any) {
            // The call itself happened; its row stays "sent" and the callback still closes it.
            console.error(`[ABDM] exchange REQUEST-ID=${requestId} could not be marked ${outcome.state}:`, error?.message);
        }
    }

    private async createSession(): Promise<string> {
        const operation = "gateway/v3/sessions";
        if (!abdmConfig.isConfigured) {
            throw abdmNotConfiguredError(operation);
        }

        const body = await this.send({
            operation,
            url: `${abdmConfig.gatewayBaseUrl}/api/hiecm/gateway/v3/sessions`,
            method: "POST",
            headers: { "X-CM-ID": abdmConfig.cmId },
            body: {
                clientId: abdmConfig.clientId,
                clientSecret: abdmConfig.clientSecret,
                grantType: "client_credentials",
            },
        });

        const token = typeof body?.accessToken === "string" ? body.accessToken : "";
        if (!token) {
            throw new AbdmApiError({ status: 502, kind: "unavailable", operation, message: "ABDM answered the session call without an access token." });
        }
        const expiresInSeconds = Number(body.expiresIn);
        const lifetimeMs = (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 1200) * 1000;
        this.session = { token, expiresAt: this.clock() + Math.max(lifetimeMs - 60_000, 30_000) };
        return token;
    }

    private async send(request: SendRequest): Promise<any> {
        const requestId = request.requestId || randomUUID();
        const headers: Record<string, string> = {
            "REQUEST-ID": requestId,
            TIMESTAMP: abdmTimestamp(),
            ...request.headers,
        };
        if (request.body !== undefined) {
            headers["Content-Type"] = "application/json";
        }

        const path = new URL(request.url).pathname;
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), abdmConfig.requestTimeoutMs);

        let status: number;
        let ok: boolean;
        let contentType: string;
        let raw: Buffer;
        try {
            const response = await fetch(request.url, {
                method: request.method,
                headers,
                body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
                signal: controller.signal,
            });
            status = response.status;
            ok = response.ok;
            contentType = response.headers.get("content-type") || "";
            raw = Buffer.from(await response.arrayBuffer());
        } catch (error: any) {
            const timedOut = error?.name === "AbortError";
            console.error(`[ABDM] ${request.method} ${path} REQUEST-ID=${requestId} -> ${timedOut ? "timeout" : "network error"} after ${Date.now() - started}ms`);
            throw new AbdmApiError({
                status: 0,
                kind: timedOut ? "timeout" : "unavailable",
                operation: request.operation,
                requestId,
                message: timedOut
                    ? `ABDM did not reply within ${Math.round(abdmConfig.requestTimeoutMs / 1000)} seconds.`
                    : "ABDM could not be reached.",
            });
        } finally {
            clearTimeout(timer);
        }

        console.log(`[ABDM] ${request.method} ${path} REQUEST-ID=${requestId} -> ${status} (${Date.now() - started}ms)`);
        request.onStatus?.(status);

        if (ok) {
            if (request.binary) {
                return { contentType: contentType || "application/octet-stream", data: raw } satisfies AbdmFile;
            }
            if (raw.length === 0) return {};
            try {
                return JSON.parse(raw.toString("utf8"));
            } catch {
                throw new AbdmApiError({ status: 502, kind: "unavailable", operation: request.operation, requestId, message: "ABDM answered with something that is not JSON." });
            }
        }

        let errorBody: unknown = null;
        if (raw.length > 0) {
            const text = raw.toString("utf8");
            try {
                errorBody = JSON.parse(text);
            } catch {
                errorBody = text;
            }
        }
        const parsed = parseAbdmError(status, errorBody);
        const kind = kindFor(status, parsed.code, parsed.message);
        console.warn(
            `[ABDM] ${request.method} ${path} REQUEST-ID=${requestId} refused: ` +
            redactDigits(`${parsed.code ?? "-"}${parsed.field ? ` field=${parsed.field}` : ""} ${parsed.message}`).slice(0, 400)
        );
        throw new AbdmApiError({
            status,
            kind,
            operation: request.operation,
            requestId,
            code: parsed.code,
            field: parsed.field,
            message: parsed.message,
        });
    }
}

export const abdmGatewayService = new AbdmGatewayService();
