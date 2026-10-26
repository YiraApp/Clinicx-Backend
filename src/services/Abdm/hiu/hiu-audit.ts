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
    /** An entry failed to decrypt or its checksum did not match. */
    DECRYPT_FAIL: "DECRYPT_FAIL",
    /** A transfer passed its window without every page. */
    TRANSFER_TIMEOUT: "TRANSFER_TIMEOUT",
    /** health-information/notify sent (outcome RECEIVED or FAILED). */
    DATA_NOTIFY_SENT: "DATA_NOTIFY_SENT",
    /** A staff member opened an artefact's records. */
    RECORD_VIEWED: "RECORD_VIEWED",
    /** Records deleted: past dataEraseAt, revoked or lapsed. */
    RECORD_PURGED: "RECORD_PURGED",
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

/** An audit sink that records nothing, for tests and tools. */
export const noopHiuAudit: HiuAudit = { record: async () => {} };
