import { createPublicKey, createVerify, type KeyObject } from "crypto";
import { abdmGatewayService, type AbdmGatewayService } from "./abdm-gateway.service.js";
import { abdmSettings, type AbdmSettings } from "./abdm-facilities.service.js";

/**
 * Proves an inbound callback came from ABDM's gateway: its bearer token must be an RS256 JWT signed
 * by a key the gateway publishes at /api/hiecm/gateway/v3/certs, still valid, and issued to an ABDM
 * client allowed in AbdmSettings, CallbackClientIds (the token's clientId or azp claim). Every ABDM client's
 * token is signed with the same keys, so without that pin any integrator could post shares here:
 * it fails closed, and a refusal names the caller so the gateway's client id can be added.
 */

/**
 * Why a token was refused, for the data push's refusal record (PUSH_REFUSED): the message is for the
 * console, the reason is what the HIU audit turns into plain words.
 */
export type CallbackAuthReason =
    | "no-token"
    | "unreadable"
    | "not-rs256"
    | "unknown-key"
    | "bad-signature"
    | "ran-out"
    | "not-yet-valid"
    | "client-not-allowed";

export class CallbackAuthError extends Error {
    readonly reason: CallbackAuthReason;
    /** For "ran-out": how many whole minutes ago the token ran out. */
    readonly ranOutMinutesAgo?: number;

    constructor(message: string, reason: CallbackAuthReason = "bad-signature", details: { ranOutMinutesAgo?: number } = {}) {
        super(message);
        this.name = "CallbackAuthError";
        this.reason = reason;
        if (details.ranOutMinutesAgo !== undefined) this.ranOutMinutesAgo = details.ranOutMinutesAgo;
    }
}

export interface CallbackVerifyOptions {
    /**
     * The ABDM client pin; on unless false. Only a HIP's data push turns it off, because a HIP signs
     * with its own client's gateway token.
     */
    pinClient?: boolean;
    /**
     * Data push only: the scheme in any case ("Bearer", "bearer"), spaces around it, or a bare JWT
     * with no scheme. HIPs' HTTP clients differ here, and none of it weakens the signature check.
     * Gateway callbacks keep the exact "Bearer <jwt>".
     */
    lenientBearer?: boolean;
    /**
     * Data push only: how long after it ran out (exp) a token correctly signed by ABDM is still
     * taken, in ms. Many HIPs reuse a cached gateway token for the push, and the push URL carries
     * its own one-time secret bound to an open transfer inside its window. Gateway callbacks keep
     * the strict expiry (CLOCK_LEEWAY_MS only).
     */
    expiryGraceMs?: number;
}

const KEYS_CACHE_MS = 60 * 60_000;
const FORCED_REFRESH_GAP_MS = 5 * 60_000;
const CLOCK_LEEWAY_MS = 60_000;

const decodeJson = (part: string): Record<string, any> => {
    try {
        return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    } catch {
        throw new CallbackAuthError("The callback token is not a readable JWT.", "unreadable");
    }
};

/**
 * The token in an Authorization header. Strict (every gateway callback): exactly "Bearer " then the
 * token. Lenient (the data push): the scheme in any case with any spaces, or a bare token with no
 * scheme; a header with another scheme, or with spaces inside the token, carries none.
 */
export const bearerToken = (authorization: string | undefined, lenient = false): string => {
    if (typeof authorization !== "string") return "";
    if (!lenient) return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const text = authorization.trim();
    const schemed = /^bearer\s+(\S+)$/i.exec(text);
    if (schemed) return schemed[1]!;
    return /^\S+$/.test(text) && !/^bearer$/i.test(text) ? text : "";
};

export class AbdmCallbackAuth {
    private keys: Map<string, KeyObject> | null = null;
    private keysFetchedAt = 0;
    private pending: Promise<Map<string, KeyObject>> | null = null;
    private readonly gateway: Pick<AbdmGatewayService, "call">;
    private readonly clock: () => number;
    private readonly settings: Pick<AbdmSettings, "callbackClientIds">;

    constructor(
        gateway: Pick<AbdmGatewayService, "call"> = abdmGatewayService,
        clock: () => number = Date.now,
        settings: Pick<AbdmSettings, "callbackClientIds"> = abdmSettings,
    ) {
        this.gateway = gateway;
        this.clock = clock;
        this.settings = settings;
    }

    /**
     * The token's claims, or a CallbackAuthError saying why it was refused. The RS256 signature by a
     * key ABDM publishes, the expiry and the not-before are always checked. The ABDM client pin
     * applies unless [options.pinClient] is false. Only the data push passes lenientBearer and
     * expiryGraceMs (CallbackVerifyOptions); every other callback stays strict.
     */
    async verify(authorization: string | undefined, options: CallbackVerifyOptions = {}): Promise<Record<string, any>> {
        const token = bearerToken(authorization, options.lenientBearer === true);
        const parts = token.split(".");
        if (parts.length !== 3) throw new CallbackAuthError("The callback carries no bearer token.", "no-token");
        const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

        const header = decodeJson(headerPart);
        if (header.alg !== "RS256" || typeof header.kid !== "string") {
            throw new CallbackAuthError("The callback token is not an RS256 token with a key id.", "not-rs256");
        }
        const key = await this.key(header.kid);
        const verifier = createVerify("RSA-SHA256");
        verifier.update(`${headerPart}.${payloadPart}`);
        if (!verifier.verify(key, Buffer.from(signaturePart, "base64url"))) {
            throw new CallbackAuthError("The callback token's signature does not match ABDM's key.", "bad-signature");
        }

        const claims = decodeJson(payloadPart);
        const now = this.clock();
        if (typeof claims.exp !== "number") throw new CallbackAuthError("The callback token has run out.", "ran-out");
        const ranOutAt = claims.exp * 1000;
        if (ranOutAt + CLOCK_LEEWAY_MS < now) {
            const graceMs = Number.isFinite(options.expiryGraceMs) ? Math.max(0, options.expiryGraceMs!) : 0;
            const minutesAgo = Math.floor((now - ranOutAt) / 60_000);
            if (ranOutAt + Math.max(CLOCK_LEEWAY_MS, graceMs) < now) {
                const message = graceMs > 0
                    ? `The callback token ran out ${minutesAgo} minutes ago, past the data push's ${Math.round(graceMs / 60_000)}-minute grace.`
                    : "The callback token has run out.";
                throw new CallbackAuthError(message, "ran-out", { ranOutMinutesAgo: minutesAgo });
            }
            // Signed by ABDM and inside the data push's grace: taken, and said so in the console.
            const caller = String(claims.clientId ?? claims.azp ?? "?").replace(/[^A-Za-z0-9_\-.]/g, "").slice(0, 64);
            console.warn(`[ABDM] data push token of ABDM client "${caller}" ran out ${minutesAgo} minutes ago; taken within the ${Math.round(graceMs / 60_000)}-minute grace (ABDM_DATA_PUSH_TOKEN_GRACE_MINUTES)`);
        }
        if (typeof claims.nbf === "number" && claims.nbf * 1000 - CLOCK_LEEWAY_MS > now) {
            throw new CallbackAuthError("The callback token is not valid yet.", "not-yet-valid");
        }
        if (options.pinClient === false) return claims;
        const allowed = await this.settings.callbackClientIds();
        const caller = String(claims.clientId ?? claims.azp ?? "");
        if (allowed.length === 0) {
            throw new CallbackAuthError(`No ABDM caller is allowed yet (AbdmSettings CallbackClientIds is empty). This call came from ABDM client "${caller}" (iss ${claims.iss ?? "?"}): if that is ABDM's gateway, add it.`, "client-not-allowed");
        }
        if (!allowed.includes(caller)) {
            throw new CallbackAuthError(`The callback came from ABDM client "${caller}", which is not allowed.`, "client-not-allowed");
        }
        return claims;
    }

    /**
     * The signing key [kid]. An unknown kid refreshes the keys, in case ABDM rotated them, but at most
     * once every few minutes: anyone can post a made-up kid, and each must not cost a call to ABDM.
     */
    private async key(kid: string): Promise<KeyObject> {
        const fresh = this.keys && this.clock() - this.keysFetchedAt < KEYS_CACHE_MS;
        let keys = fresh ? this.keys! : await this.fetchKeys();
        if (!keys.has(kid) && fresh && this.clock() - this.keysFetchedAt >= FORCED_REFRESH_GAP_MS) keys = await this.fetchKeys();
        const key = keys.get(kid);
        if (!key) throw new CallbackAuthError("The callback token was signed with a key ABDM does not publish.", "unknown-key");
        return key;
    }

    private async fetchKeys(): Promise<Map<string, KeyObject>> {
        if (!this.pending) {
            this.pending = (async () => {
                const body = await this.gateway.call<{ keys?: any[] }>({
                    operation: "gateway/v3/certs",
                    method: "GET",
                    host: "gateway",
                    path: "/api/hiecm/gateway/v3/certs",
                });
                const keys = new Map<string, KeyObject>();
                for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
                    if (jwk?.kty === "RSA" && typeof jwk.kid === "string") {
                        keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
                    }
                }
                this.keys = keys;
                this.keysFetchedAt = this.clock();
                return keys;
            })().finally(() => {
                this.pending = null;
            });
        }
        return this.pending;
    }
}

export const abdmCallbackAuth = new AbdmCallbackAuth();
