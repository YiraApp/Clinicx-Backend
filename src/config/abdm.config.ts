/**
 * ABDM (Ayushman Bharat Digital Mission) settings.
 * Values come from .env locally and from Azure Application Settings when deployed. Only the
 * client credentials and hosts live here: which hospital acts as which ABDM facility, the bridge
 * URL and the callers allowed on callbacks are in the database (AbdmFacilities, AbdmSettings).
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
export const isDataPushBase = (value: string): boolean => value.length <= 255 - 22 - 64 && /^https?:\/\/[a-zA-Z0-9_\-@,.:=?/&]+$/.test(value);

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

    get certificateCacheMs(): number {
        const minutes = Number(env("ABDM_CERT_CACHE_MINUTES"));
        return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
    },

    // ---- Milestone 3: ClinicX as a Health Information User (HIU) ----

    /**
     * Legacy: the one HIU id of the deployment, from before each hospital requested records as its
     * own HFR facility (AbdmFacilities.HiuId, else its HipId). Read ONLY by the startup migration,
     * to fill in the HIU id of requests raised under it; no call or callback uses it.
     */
    get hiuId(): string {
        return env("ABDM_HIU_ID");
    },

    /** Legacy, like hiuId: no longer read (the HIU's name is its facility's name). Defaults to the HIP name. */
    get hiuName(): string {
        return env("ABDM_HIU_NAME") || env("ABDM_HIP_NAME");
    },

    /**
     * Public origin HIPs push encrypted records to (POST {base}/api/v3/hiu/data-push/{token}), with
     * no trailing slash. In dev the ngrok domain; deployed, the backend host. One for the whole
     * deployment; when empty, the bridge URL (AbdmSettings) is used.
     */
    get dataPushBaseUrl(): string {
        return withoutTrailingSlash(env("ABDM_DATA_PUSH_BASE_URL"));
    },

    /** Largest data push body accepted, in megabytes; bigger answers 413. */
    get dataPushMaxMb(): number {
        const value = Number(env("ABDM_DATA_PUSH_MAX_MB"));
        return Number.isFinite(value) && value > 0 ? value : 20;
    },

    /**
     * Minutes after it ran out that a HIP's gateway token, correctly signed by ABDM, is still taken
     * on the data push (ABDM_DATA_PUSH_TOKEN_GRACE_MINUTES, default 60, 0 turns it off, at most a
     * day). Many HIPs push with a cached gateway token; the push URL's own one-time token, bound to
     * an open transfer inside its window, is what admits the page. Gateway callbacks are not given it.
     */
    get dataPushTokenGraceMinutes(): number {
        const text = env("ABDM_DATA_PUSH_TOKEN_GRACE_MINUTES");
        const value = Number(text);
        return text !== "" && Number.isFinite(value) && value >= 0 ? Math.min(value, 24 * 60) : 60;
    },

    /**
     * Whether a data push must carry a gateway token (ABDM_DATA_PUSH_REQUIRE_TOKEN: "true", "1" or
     * "yes"). Off by default: many sandbox HIPs push with no Authorization header at all (10 of 15
     * that pushed on 2026-11-23), and the push address is itself a one-time secret, 32 random bytes
     * bound to one open transfer inside its window, with entries encrypted to that transfer's key and
     * checksummed. A token that is sent is still checked either way.
     */
    get dataPushRequiresToken(): boolean {
        return /^(true|1|yes)$/i.test(env("ABDM_DATA_PUSH_REQUIRE_TOKEN"));
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

    /**
     * How long one large HIU write (a data push page's insert, a record's delete) may run, in ms. A
     * multi-megabyte write on a small database (Azure SQL Basic) can take well past the app's own
     * statement limit while the log is busy; at least 30 s, default 120 s.
     */
    get hiuLargeWriteTimeoutMs(): number {
        const value = Number(env("ABDM_HIU_LARGE_WRITE_TIMEOUT_MS"));
        return Number.isFinite(value) && value >= 30_000 ? value : 120_000;
    },

    /**
     * How our public key is written in a health-information request's dhPublicKey.keyValue
     * (ABDM_HIU_KEY_FORMAT): "point", the default, is the bare uncompressed point 04||x||y in base64,
     * the form the PHR app sends (162 of the 172 bare-point requests our HIP received; 172 of 181
     * from HIUs other than ClinicX) and the one HIPs built on Fidelius or ProjectEKA read; "spki" is
     * the X.509 SubjectPublicKeyInfo ClinicX sent before, which those HIPs cannot read. Anything else
     * is "point". One HIP can be kept on "spki" with ABDM_HIU_SPKI_KEY_HIPS (hiuKeyFormatFor).
     */
    get hiuKeyFormat(): "point" | "spki" {
        return env("ABDM_HIU_KEY_FORMAT").toLowerCase() === "spki" ? "spki" : "point";
    },

    /** HIP ids that are sent "spki" whatever hiuKeyFormat says (ABDM_HIU_SPKI_KEY_HIPS, comma separated). */
    get hiuSpkiKeyHips(): string[] {
        return env("ABDM_HIU_SPKI_KEY_HIPS").split(",").map((id) => id.trim()).filter(Boolean);
    },

    /** The keyValue format for a request to [hipId]: "spki" for a listed HIP, else hiuKeyFormat. */
    hiuKeyFormatFor(hipId: string | null | undefined): "point" | "spki" {
        const id = (hipId ?? "").trim().toLowerCase();
        return id && this.hiuSpkiKeyHips.some((listed) => listed.toLowerCase() === id) ? "spki" : this.hiuKeyFormat;
    },

    /** Minutes a health-information transfer may take before it is notified FAILED. */
    get hiuTransferWindowMinutes(): number {
        const value = Number(env("ABDM_HIU_TRANSFER_WINDOW_MINUTES"));
        return Number.isFinite(value) && value > 0 ? value : 20;
    },

    /**
     * The deployment can act as an HIU: a 32-byte data key with a usable key id, and a push address
     * that is usable when set (left empty, the bridge URL is used, checked where it is read). Which
     * HIU id a hospital asks as is per hospital (AbdmFacilities), not part of this.
     */
    get hiuConfigured(): boolean {
        return isDataKey(this.hiuDataKey) && isDataKeyId(this.hiuDataKeyId) && (!this.dataPushBaseUrl || isDataPushBase(this.dataPushBaseUrl));
    },

    get isConfigured(): boolean {
        return this.clientId.length > 0 && this.clientSecret.length > 0;
    },

    requestTimeoutMs: 30_000,
};
