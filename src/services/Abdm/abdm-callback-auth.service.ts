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

export class CallbackAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CallbackAuthError";
    }
}

const KEYS_CACHE_MS = 60 * 60_000;
const FORCED_REFRESH_GAP_MS = 5 * 60_000;
const CLOCK_LEEWAY_MS = 60_000;

const decodeJson = (part: string): Record<string, any> => {
    try {
        return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    } catch {
        throw new CallbackAuthError("The callback token is not a readable JWT.");
    }
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
     * The token's claims, or a CallbackAuthError saying why it was refused. The signature, expiry and
     * not-before are always checked. The ABDM client pin applies unless [options.pinClient] is false:
     * only a HIP's data push turns it off, because a HIP signs with its own client's gateway token.
     */
    async verify(authorization: string | undefined, options: { pinClient?: boolean } = {}): Promise<Record<string, any>> {
        const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
        const parts = token.split(".");
        if (parts.length !== 3) throw new CallbackAuthError("The callback carries no bearer token.");
        const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

        const header = decodeJson(headerPart);
        if (header.alg !== "RS256" || typeof header.kid !== "string") {
            throw new CallbackAuthError("The callback token is not an RS256 token with a key id.");
        }
        const key = await this.key(header.kid);
        const verifier = createVerify("RSA-SHA256");
        verifier.update(`${headerPart}.${payloadPart}`);
        if (!verifier.verify(key, Buffer.from(signaturePart, "base64url"))) {
            throw new CallbackAuthError("The callback token's signature does not match ABDM's key.");
        }

        const claims = decodeJson(payloadPart);
        const now = this.clock();
        if (typeof claims.exp !== "number" || claims.exp * 1000 + CLOCK_LEEWAY_MS < now) {
            throw new CallbackAuthError("The callback token has run out.");
        }
        if (typeof claims.nbf === "number" && claims.nbf * 1000 - CLOCK_LEEWAY_MS > now) {
            throw new CallbackAuthError("The callback token is not valid yet.");
        }
        if (options.pinClient === false) return claims;
        const allowed = await this.settings.callbackClientIds();
        const caller = String(claims.clientId ?? claims.azp ?? "");
        if (allowed.length === 0) {
            throw new CallbackAuthError(`No ABDM caller is allowed yet (AbdmSettings CallbackClientIds is empty). This call came from ABDM client "${caller}" (iss ${claims.iss ?? "?"}): if that is ABDM's gateway, add it.`);
        }
        if (!allowed.includes(caller)) {
            throw new CallbackAuthError(`The callback came from ABDM client "${caller}", which is not allowed.`);
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
        if (!key) throw new CallbackAuthError("The callback token was signed with a key ABDM does not publish.");
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
