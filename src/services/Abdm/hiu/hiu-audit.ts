/**
 * The HIU audit trail (plan section 11): one row per consent or data-flow step and per staff view
 * of records, in AbdmHiuAuditEvents. Ids, statuses, counts and outcomes only: never patient data,
 * ABHA addresses, care-context references, content, keys, nonces or tokens.
 *
 * Writing an event never fails the step it records: record() logs and swallows its own errors.
 */

export interface HiuAuditEventInput {
    /** The hospital the request belongs to; null when not yet known (an unknown callback). */
    hospitalId: number | null;
    /** The staff member, for staff actions; null or absent for ABDM callbacks and the scheduler. */
    staffUserId?: string | null;
    /** One of HIU_AUDIT_EVENTS. */
    event: string;
    /** ABDM's consent request id. */
    consentRequestId?: string | null;
    /** ABDM's consent artefact id. */
    artefactId?: string | null;
    transactionId?: string | null;
    /** The REQUEST-ID of the call or callback. */
    requestId?: string | null;
    /** One of HIU_AUDIT_OUTCOMES, or a status ABDM reported. */
    outcome: string;
    /** A short note with no patient data, such as an ABDM error code or "page 2 of 3". */
    detail?: string | null;
}

export interface HiuAudit {
    record(event: HiuAuditEventInput): Promise<void>;
}

/** Every event the HIU records. */
export const HIU_AUDIT_EVENTS = {
    /** consent/request/init sent (or refused before an answer). */
    CONSENT_INIT: "CONSENT_INIT",
    /** on-init arrived: ABDM's consent request id, or its error. */
    ON_INIT: "ON_INIT",
    /** consent/request/status sent (staff "Refresh status"). */
    STATUS_REQUEST: "STATUS_REQUEST",
    ON_STATUS: "ON_STATUS",
    /** consent/request/notify arrived, by status. */
    NOTIFY_GRANTED: "NOTIFY_GRANTED",
    NOTIFY_DENIED: "NOTIFY_DENIED",
    NOTIFY_EXPIRED: "NOTIFY_EXPIRED",
    NOTIFY_REVOKED: "NOTIFY_REVOKED",
    NOTIFY_REQUESTED: "NOTIFY_REQUESTED",
    /** consent/request/hiu/on-notify acknowledgement sent. */
    ON_NOTIFY_SENT: "ON_NOTIFY_SENT",
    /** consent/fetch sent for one artefact. */
    FETCH: "FETCH",
    ON_FETCH: "ON_FETCH",
    /** health-information/request sent for one artefact. */
    HI_REQUEST: "HI_REQUEST",
    ON_REQUEST: "ON_REQUEST",
    /** A data push page arrived (detail: "page n of m, k entries"). */
    PAGE_RECEIVED: "PAGE_RECEIVED",
    /**
     * A HIP's push to a known transfer's address was refused (outcome REJECTED; detail
     * "<HTTP status>: <plain reason>", pushRefusalDetail). Without it a refused push looks the same
     * as a HIP that sent nothing. Append-only: a repeat of the transfer's newest refusal (same cause,
     * sameRefusalCause; no page stored since) is not written again, and at most HIU_PUSH_REFUSALS_KEPT are written per
     * transfer. An unknown push address is never recorded.
     */
    PUSH_REFUSED: "PUSH_REFUSED",
    /** An entry failed to decrypt or its checksum did not match. */
    DECRYPT_FAIL: "DECRYPT_FAIL",
    /** A data push page was accepted but could not be stored, after its retries (detail: "page n of m: code"). */
    PAGE_STORE_FAILED: "PAGE_STORE_FAILED",
    /** A transfer passed its window without every page. */
    TRANSFER_TIMEOUT: "TRANSFER_TIMEOUT",
    /** health-information/notify sent (outcome RECEIVED or FAILED). */
    DATA_NOTIFY_SENT: "DATA_NOTIFY_SENT",
    /** A staff member opened an artefact's records. */
    RECORD_VIEWED: "RECORD_VIEWED",
    /** Records deleted: past dataEraseAt, revoked, lapsed or closed. */
    RECORD_PURGED: "RECORD_PURGED",
    /**
     * ClinicX closed an artefact (CLOSED) because another facility of its request was revoked or
     * lapsed, so the whole request ended. ClinicX's own act: ABDM is not told.
     */
    ARTEFACT_CLOSED: "ARTEFACT_CLOSED",
    /** ClinicX ended a granted consent (EXPIRED) at its delete-by time: ABDM sends no notice of that. */
    CONSENT_LAPSED: "CONSENT_LAPSED",
} as const;

export type HiuAuditEventName = (typeof HIU_AUDIT_EVENTS)[keyof typeof HIU_AUDIT_EVENTS];

/** The event for a consent/request/notify of [status]: NOTIFY_GRANTED, NOTIFY_DENIED and so on. */
export const notifyAuditEvent = (status: string): string => `NOTIFY_${String(status).toUpperCase().replace(/[^A-Z_]/g, "").slice(0, 40)}`;

/** Outcomes most events record. A status ABDM reported may be recorded as the outcome instead. */
export const HIU_AUDIT_OUTCOMES = {
    /** Sent and accepted (202), or processed. */
    OK: "OK",
    /** ABDM, or our own checks, refused it. */
    REJECTED: "REJECTED",
    /** It could not be completed (network, timeout, decryption). */
    FAILED: "FAILED",
    /** A repeat or an unknown id: logged and dropped. */
    IGNORED: "IGNORED",
} as const;

/**
 * The most PUSH_REFUSED rows one transfer keeps (its hard ceiling). A repeat of the newest kept
 * refusal is never written, so the ceiling is only reached by refusals whose reason keeps changing:
 * a new reason is always shown until then, and a HIP sending refused pushes again and again cannot
 * fill the audit table. Refusals past it reach the console only.
 */
export const HIU_PUSH_REFUSALS_KEPT = 20;

/** What happened to one refused push's PUSH_REFUSED row (HiuDataStore.addPushRefusal). */
export type PushRefusalWrite = "recorded" | "repeat" | "full";

/** A refused push as the transfer's view shows it: the status we answered, the reason and when. */
export interface PushRefusal {
    status: number;
    reason: string;
    at: Date;
}

/**
 * PUSH_REFUSED's detail: "<status>: <reason>". The reason is plain words with no patient data, and
 * never the word the frontend reads as its own login lapsing (the callers say "ran out" or "too old").
 */
export const pushRefusalDetail = (status: number, reason: string): string =>
    `${Number.isInteger(status) ? status : 400}: ${String(reason).replace(/expired/gi, "ran out").replace(/\s+/g, " ").trim()}`.slice(0, 500);

/**
 * Whether two PUSH_REFUSED details give the same cause: the same status, and the same text with
 * its digits (and any '#') left out, so "ran out 9 minutes ago" and "ran out 91 minutes ago" are
 * one cause and a HIP retrying it every minute does not fill the transfer's allowance.
 * addPushRefusalSql compares the same way (LEFT 4, then TRANSLATE the digits to '#' and drop '#').
 */
export const sameRefusalCause = (a: string, b: string): boolean =>
    a.slice(0, 4) === b.slice(0, 4) && a.replace(/[0-9#]/g, "") === b.replace(/[0-9#]/g, "");

/** The status and reason back from a PUSH_REFUSED detail; null when it is not in that form. */
export const readPushRefusalDetail = (detail: string | null | undefined): { status: number; reason: string } | null => {
    const match = /^(\d{3}): ([\s\S]+)$/.exec(String(detail ?? "").trim());
    return match ? { status: Number(match[1]), reason: match[2]!.trim() } : null;
};

/** An audit sink that records nothing, for tests and tools. */
export const noopHiuAudit: HiuAudit = { record: async () => {} };
