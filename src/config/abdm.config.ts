/**
 * ABDM (Ayushman Bharat Digital Mission) settings.
 * Values come from .env locally and from Azure Application Settings when deployed.
 * Read on every access so a changed setting (or a test) takes effect without a restart.
 */
const env = (name: string): string => (process.env[name] || "").trim();
const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, "");
/** Base64 that decodes to exactly 32 bytes (an AES-256 key). */
const isDataKey = (value: string): boolean =>
    value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === 32;
/** A key id the sealed format can carry (same rule as hiu-at-rest.ts), so the two never disagree. */
const isDataKeyId = (value: string): boolean => /^[A-Za-z0-9_-]{1,32}$/.test(value);
/**
 * A push base the full dataPushUrl can be built from: an http(s) origin in ABDM's dataPushUrl
 * character set, short enough that base + "/api/v3/hiu/data-push/" + a 64-character token stays
 * within ABDM's 255 characters (hiu-enums DATA_PUSH_URL_PATTERN; hiu-data-flow.service.ts).
 */
const isDataPushBase = (value: string): boolean => value.length <= 255 - 22 - 64 && /^https?:\/\/[a-zA-Z0-9_\-@,.:=?/&]+$/.test(value);

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
     * How many minutes a Scan and Share queue token stays valid at the clinic. The test cases
     * expect 60. Always minutes: ABDM_SHARE_EXPIRY_UNIT sets only how it is sent to ABDM.
     */
    get shareTokenExpiry(): number {
        const value = Number(env("ABDM_SHARE_TOKEN_EXPIRY"));
        return Number.isFinite(value) && value > 0 ? value : 60;
    },

    /**
     * The unit of the on-share "expiry" ABDM receives: "minutes" (default) or "seconds".
     * ABDM's specification gives expiry as a number without a unit; confirm it at onboarding.
     */
    get shareExpiryUnit(): "minutes" | "seconds" {
        return env("ABDM_SHARE_EXPIRY_UNIT").toLowerCase() === "seconds" ? "seconds" : "minutes";
    },

    /**
     * Client ids allowed to call our callbacks (comma separated). Empty refuses every callback:
     * the check fails closed rather than accepting any ABDM-signed token.
     */
    get callbackClientIds(): string[] {
        return env("ABDM_CALLBACK_CLIENT_IDS").split(",").map((id) => id.trim()).filter(Boolean);
    },

    get certificateCacheMs(): number {
        const minutes = Number(env("ABDM_CERT_CACHE_MINUTES"));
        return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
    },

    // ---- Milestone 3: ClinicX as a Health Information User (HIU) ----

    /**
     * The HIU service id sent as X-HIU-ID and consent.hiu.id. Kept separate from ABDM_HIP_ID and
     * never defaulted to it: while it is empty every HIU endpoint answers not-configured.
     */
    get hiuId(): string {
        return env("ABDM_HIU_ID");
    },

    /** consent.hiu.name. Defaults to the HIP name. */
    get hiuName(): string {
        return env("ABDM_HIU_NAME") || env("ABDM_HIP_NAME");
    },

    /**
     * Public origin HIPs push encrypted records to (POST {base}/api/v3/hiu/data-push/{token}), with
     * no trailing slash. In dev the ngrok domain; deployed, the backend host.
     */
    get dataPushBaseUrl(): string {
        return withoutTrailingSlash(env("ABDM_DATA_PUSH_BASE_URL"));
    },

    /** Largest data push body accepted, in megabytes; bigger answers 413. */
    get dataPushMaxMb(): number {
        const value = Number(env("ABDM_DATA_PUSH_MAX_MB"));
        return Number.isFinite(value) && value > 0 ? value : 20;
    },

    /** Largest total of entry content one transfer may push, in megabytes; a page beyond it answers 413. */
    get dataPushMaxTransferMb(): number {
        const value = Number(env("ABDM_DATA_PUSH_MAX_TRANSFER_MB"));
        return Number.isFinite(value) && value > 0 ? value : 100;
    },

    /**
     * Server key that seals stored records and ephemeral private keys: base64 of 32 bytes. Secret:
     * read it only to build the at-rest key set, never log it.
     */
    get hiuDataKey(): string {
        return env("ABDM_HIU_DATA_KEY");
    },

    /** Id written beside every sealed value, so a rotated key can still open older rows. */
    get hiuDataKeyId(): string {
        return env("ABDM_HIU_DATA_KEY_ID") || "k1";
    },

    /** Role names allowed to raise and read HIU record requests, matched case-insensitively. */
    get hiuRoleNames(): string[] {
        const names = env("ABDM_HIU_ROLE_NAMES").split(",").map((name) => name.trim()).filter(Boolean);
        return names.length > 0 ? names : ["Provider", "Hospital Admin"];
    },

    /** Minutes a health-information transfer may take before it is notified FAILED. */
    get hiuTransferWindowMinutes(): number {
        const value = Number(env("ABDM_HIU_TRANSFER_WINDOW_MINUTES"));
        return Number.isFinite(value) && value > 0 ? value : 20;
    },

    /**
     * The HIU id, a 32-byte data key with a usable key id, and a usable push address are all set.
     * Checked up front so a consent is never raised whose records could not then be requested.
     */
    get hiuConfigured(): boolean {
        return this.hiuId.length > 0 && isDataKey(this.hiuDataKey) && isDataKeyId(this.hiuDataKeyId) && isDataPushBase(this.dataPushBaseUrl);
    },

    get isConfigured(): boolean {
        return this.clientId.length > 0 && this.clientSecret.length > 0;
    },

    requestTimeoutMs: 30_000,
};
