/**
 * What the API log may keep of a request or a response.
 * Passwords are always masked. On the ABDM routes the Aadhaar number, OTPs and mobile numbers
 * are masked too, and a response keeps only its status, message and error details: never the
 * ABHA profile, photo or card.
 */

const MASK = "********";
const ALWAYS_MASKED = ["password", "Password"];
// "identifier" carries the Aadhaar number (or ABHA number/address) on the verify routes.
const ABDM_MASKED = ["aadhaar", "otp", "mobile", "identifier", "abhaAddress", "abhaNumber"];

export const isAbdmPath = (path: string): boolean => (path || "").toLowerCase().startsWith("/api/abdm");

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

export const maskRequestBodyForLog = (path: string, body: unknown): unknown => {
    if (body === null || typeof body !== "object") return body;
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
        return JSON.stringify({ status: body?.status, message: body?.message, ...(errorDetails ? { data: errorDetails } : {}) });
    } catch {
        return "[ABDM response not logged]";
    }
};
