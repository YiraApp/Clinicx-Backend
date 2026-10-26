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

    /**
     * HIP ids this deployment answers Scan and Share for (comma separated). The first one goes on
     * the counter QR code.
     */
    get hipIds(): string[] {
        return env("ABDM_HIP_ID").split(",").map((id) => id.trim()).filter(Boolean);
    },

    /** The ClinicX hospital a Scan and Share patient is registered at. */
    get hipHospitalId(): number | null {
        const id = Number(env("ABDM_HIP_HOSPITAL_ID"));
        return Number.isInteger(id) && id > 0 ? id : null;
    },

    /** PHR app host the counter QR code opens: phrsbx.abdm.gov.in in the sandbox. */
    get phrBaseUrl(): string {
        return withoutTrailingSlash(env("ABDM_PHR_BASE_URL") || "https://phrsbx.abdm.gov.in");
    },

    /**
     * How long a Scan and Share queue token stays valid, sent to ABDM as on-share "expiry".
     * ABDM's specification gives expiry as a number without a unit; the test cases expect a token
     * valid for 60 minutes. Confirm the unit at onboarding and set this to match.
     */
    get shareTokenExpiry(): number {
        const value = Number(env("ABDM_SHARE_TOKEN_EXPIRY"));
        return Number.isFinite(value) && value > 0 ? value : 60;
    },

    /** Client ids allowed to call our callbacks (comma separated); empty accepts any ABDM-signed token. */
    get callbackClientIds(): string[] {
        return env("ABDM_CALLBACK_CLIENT_IDS").split(",").map((id) => id.trim()).filter(Boolean);
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
