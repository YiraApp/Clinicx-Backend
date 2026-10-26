/**
 * What the API log may keep of a request or a response.
 * Passwords are always masked. On the ABDM routes the Aadhaar number, OTPs, mobile numbers, ABHA
 * addresses and the M3 record-request fields (care contexts, content, key material) are masked
 * too, and a response keeps only its status, message and error details: never the ABHA profile,
 * photo or card, nor a decrypted record. ABDM's callbacks (/api/v3) keep no body here at all:
 * they are stored in AbdmExchanges. Credential headers are masked on every route.
 */

const MASK = "********";
const ALWAYS_MASKED = ["password", "Password"];
// "identifier" carries the Aadhaar number (or ABHA number/address) on the verify routes.
// The rest are M3 (HIU) record-request fields: care-context references, record content, key
// material, the patient name and the per-transfer push address (it carries the push token).
const ABDM_MASKED = [
    "aadhaar", "otp", "mobile", "identifier", "abhaAddress", "abhaNumber",
    "patientReference", "careContextReference", "careContexts", "content", "keyValue", "nonce",
    "privateKey", "patientName", "dataPushUrl",
];
/** Credentials ABDM bodies carry: never stored or logged in clear. */
const CREDENTIAL_KEYS = ["linkToken", "accessToken", "refreshToken", "token", "otp", "otpValue", "password", "aadhaar"];
const CREDENTIAL_HEADERS = ["authorization", "x-link-token", "x-token", "t-token", "r-token"];

export const isAbdmCallbackPath = (path: string): boolean => (path || "").toLowerCase().startsWith("/api/v3/");

export const isAbdmPath = (path: string): boolean =>
    (path || "").toLowerCase().startsWith("/api/abdm") || isAbdmCallbackPath(path);

const maskDeep = (value: unknown, keys: Set<string>, depth: number): unknown => {
    if (depth > 5 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => maskDeep(item, keys, depth + 1));
    const masked: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        masked[key] = keys.has(key) && inner !== undefined && inner !== null && inner !== ""
            ? MASK
            : maskDeep(inner, keys, depth + 1);
    }
    return masked;
};

/** An ABDM body with every credential masked and everything else, including its shape, kept. */
export const maskCredentials = (body: unknown): unknown => maskDeep(body, new Set(CREDENTIAL_KEYS), 0);

/** Request headers for the log, with credential headers (a login token, ABDM's tokens) masked on every route. */
export const maskHeadersForLog = (_path: string, headers: Record<string, unknown>): Record<string, unknown> => {
    const masked: Record<string, unknown> = { ...headers };
    for (const name of CREDENTIAL_HEADERS) {
        if (masked[name] !== undefined) masked[name] = MASK;
    }
    return masked;
};

export const maskRequestBodyForLog = (path: string, body: unknown): unknown => {
    if (body === null || typeof body !== "object") return body;
    if (isAbdmCallbackPath(path)) {
        return { body: "not logged: ABDM callbacks are stored in AbdmExchanges" };
    }
    if (isAbdmPath(path)) {
        return maskDeep(body, new Set([...ALWAYS_MASKED, ...ABDM_MASKED]), 0);
    }
    // Elsewhere: the top-level password fields, as before.
    const masked: Record<string, unknown> = { ...(body as Record<string, unknown>) };
    for (const key of ALWAYS_MASKED) {
        if (masked[key]) masked[key] = MASK;
    }
    return masked;
};

export const maskResponseForLog = (path: string, responseText: string): string => {
    if (!isAbdmPath(path)) return responseText;
    try {
        const body = JSON.parse(responseText);
        const data = body?.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : null;
        const errorDetails = data?.kind
            ? { kind: data.kind, abdmCode: data.abdmCode ?? null, abdmMessage: data.abdmMessage ?? null, field: data.field ?? null, requestId: data.requestId ?? null }
            : undefined;
        // A refused ABDM callback answers { error: { message } } in our own words (why, and which caller):
        // kept, so a refusal is visible in the log rather than an empty line.
        const callbackRefusal = isAbdmCallbackPath(path) && typeof body?.error?.message === "string" ? { error: { message: body.error.message } } : {};
        return JSON.stringify({ status: body?.status, message: body?.message, ...(errorDetails ? { data: errorDetails } : {}), ...callbackRefusal });
    } catch {
        return "[ABDM response not logged]";
    }
};

/** The request headers the API log keeps: all of them except Authorization (the caller's JWT). */
export const headersForLog = (headers: Record<string, unknown>): Record<string, unknown> => {
    const kept: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(headers || {})) {
        if (name.toLowerCase() !== "authorization") kept[name] = value;
    }
    return kept;
};
