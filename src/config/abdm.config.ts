/**
 * ABDM (Ayushman Bharat Digital Mission) settings.
 * Values come from .env locally and from Azure Application Settings when deployed.
 * Read on every access so a changed setting (or a test) takes effect without a restart.
 */
const env = (name: string): string => (process.env[name] || "").trim();
const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

export const abdmConfig = {
    get clientId(): string {
        return env("ABDM_CLIENT_ID");
    },

    get clientSecret(): string {
        return env("ABDM_CLIENT_SECRET");
    },

    /** HIE-CM gateway: issues the session token. Sandbox by default. */
    get gatewayBaseUrl(): string {
        return withoutTrailingSlash(env("ABDM_GATEWAY_BASE_URL") || "https://dev.abdm.gov.in");
    },

    /** ABHA service: every M1 call. Sandbox by default. */
    get abhaBaseUrl(): string {
        return withoutTrailingSlash(env("ABDM_ABHA_BASE_URL") || "https://abhasbx.abdm.gov.in");
    },

    /** Consent manager id sent as X-CM-ID: "sbx" in the sandbox. */
    get cmId(): string {
        return env("ABDM_CM_ID") || "sbx";
    },

    /** Suffix ABHA addresses carry in this environment. */
    get abhaAddressSuffix(): string {
        return this.cmId === "sbx" ? "@sbx" : "@abdm";
    },

    get certificateCacheMs(): number {
        const minutes = Number(env("ABDM_CERT_CACHE_MINUTES"));
        return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
    },

    get isConfigured(): boolean {
        return this.clientId.length > 0 && this.clientSecret.length > 0;
    },

    requestTimeoutMs: 30_000,
};
