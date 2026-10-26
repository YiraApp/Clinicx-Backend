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
 *   { error: { code, message } }          business and UIDAI refusals
 *   { code, message, description }        gateway authentication
 *   { message, timestamp }                generic
 *   { <field>: "<message>", timestamp }   request validation, naming the field
 *   an empty body
 */
export const parseAbdmError = (status: number, body: unknown): { code: string | null; message: string; field: string | null } => {
    const fallback = `ABDM answered with HTTP ${status} and no message.`;

    if (!body || typeof body !== "object") {
        const text = typeof body === "string" ? body.trim() : "";
        return { code: null, message: text ? text.slice(0, 300) : fallback, field: null };
    }

    const b = body as Record<string, any>;
    if (b.error && typeof b.error === "object") {
        return { code: normalizeAbdmCode(b.error.code), message: String(b.error.message || fallback), field: null };
    }
    if (typeof b.message === "string" || b.code !== undefined) {
        return { code: normalizeAbdmCode(b.code), message: String(b.message || b.description || fallback), field: null };
    }

    const field = Object.keys(b).find((key) => key !== "timestamp" && typeof b[key] === "string");
    if (field) {
        return { code: null, message: String(b[field]), field };
    }
    return { code: null, message: fallback, field: null };
};

const kindFor = (status: number, code: string | null, message: string): AbdmErrorKind => {
    // 9009xx come from ABDM's API manager: the client or its token was refused.
    if (code && /^9009\d\d$/.test(code)) return "credentials";
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
    method: "GET" | "POST";
    /** Path on the ABHA service, starting with /abha/api/v3. */
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    /** The answer is a file (the ABHA card), not JSON. */
    binary?: boolean;
}

export interface AbdmFile {
    contentType: string;
    data: Buffer;
}

interface SendRequest {
    operation: string;
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: unknown;
    binary?: boolean;
}

export class AbdmGatewayService {
    private session: { token: string; expiresAt: number } | null = null;
    private pendingSession: Promise<string> | null = null;
    private readonly clock: () => number;

    constructor(clock: () => number = Date.now) {
        this.clock = clock;
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
     * One call to the ABHA service with the gateway token. A credentials refusal clears the
     * cached token so the next call starts a new session; it is never retried here, because
     * a credential check must not loop.
     */
    async call<T = any>(call: AbdmCall): Promise<T> {
        const token = await this.getAccessToken();
        try {
            return await this.send({
                operation: call.operation,
                url: `${abdmConfig.abhaBaseUrl}${call.path}`,
                method: call.method,
                headers: { Authorization: `Bearer ${token}`, ...call.headers },
                body: call.body,
                binary: call.binary,
            });
        } catch (error) {
            if (error instanceof AbdmApiError && error.kind === "credentials") {
                this.clearAccessToken();
            }
            throw error;
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
        const requestId = randomUUID();
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
