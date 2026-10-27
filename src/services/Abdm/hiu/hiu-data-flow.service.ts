import { createHash, randomBytes, randomUUID } from "crypto";
import { abdmConfig } from "../../../config/abdm.config.js";
import type { AbdmSettings } from "../abdm-facilities.service.js";
import { AbdmApiError, abdmGatewayService, isOutcomeUnknown, type AbdmGatewayService } from "../abdm-gateway.service.js";
import {
    decryptEntry as fideliusDecrypt,
    generateKeyMaterial as fideliusKeyMaterial,
    HiuCryptoError,
    KEY_MATERIAL_CRYPTO_ALG,
    KEY_MATERIAL_CURVE,
    KEY_MATERIAL_PARAMETERS,
    verifyChecksum as fideliusVerifyChecksum,
    type HiuKeyMaterial,
} from "./fidelius-crypto.js";
import { atRestKeysFromConfig, open, seal, type AtRestKeys } from "./hiu-at-rest.js";
import { HIU_AUDIT_EVENTS, HIU_AUDIT_OUTCOMES, type HiuAudit } from "./hiu-audit.js";
// Type-only: the shared staff and callback shapes live with the consent service; no runtime cycle.
import type { CallbackHeaders, HealthInformationRequester, StaffContext } from "./hiu-consent.service.js";
import {
    abdmDateTime,
    HIU_ENTRY_MEDIA,
    HiuError,
    hiuFacilityNotConfiguredError,
    hiuNotConfiguredError,
    isDataPushUrl,
    type HiuHiStatus,
    type HiuNotifySessionStatus,
    type SessionStatus,
} from "./hiu-enums.js";

/**
 * ABDM Milestone 3, the data-flow half of the HIU (plan sections 3, 6 and 10):
 *
 *   requestForArtefact  POST /api/hiecm/data-flow/v3/health-information/request for one GRANTED,
 *                       fetched artefact, with a fresh Curve25519 key pair and nonce, the granted
 *                       date range exactly, and a one-time dataPushUrl.
 *   onRequest           ABDM's acknowledgement: the transaction id, or a refusal.
 *   acceptPush          A HIP's page at our dataPushUrl. What can be checked without decrypting
 *                       is checked at once (token, transaction, window, shape); the page is then
 *                       decrypted and stored in the background, and the HIP gets its 202.
 *   records             The decrypted records of one artefact, for staff of its hospital, only
 *                       while the artefact is GRANTED and before its dataEraseAt.
 *
 * Once every page up to pageCount has arrived, one health-information/notify reports the transfer
 * (RECEIVED, or FAILED when an entry could not be decrypted or verified), with hiStatus OK or
 * ERRORED per care context. A transfer that does not finish inside its window is notified FAILED
 * by the maintenance sweep (failTransfer). Either way our private key is set to NULL.
 *
 * Per tenant: every call and notify about an artefact carries the HIU id its consent request was
 * raised as (the request row's HiuId), and on-request is taken only from that same X-HIU-ID. The
 * push address is the deployment's (ABDM_DATA_PUSH_BASE_URL, else the bridge URL).
 *
 * Logs carry the transaction id, page n of m, counts and outcomes only: never content, keys,
 * nonces, push tokens, care-context references or ABHA addresses.
 */

/** The seam the consent service calls after an on-fetch shows a GRANTED artefact (defined beside it). */
export type { HealthInformationRequester };

export interface RecordView {
    id: number;
    pageNumber: number;
    entryIndex: number;
    careContextReference: string | null;
    media: string | null;
    checksumOk: boolean;
    receivedAt: string;
    bundle: unknown | null;
    raw: string | null;
    /**
     * True when the content was left out to keep the answer within HIU_RECORDS_RESPONSE_MAX_BYTES;
     * GET /artefacts/:id/records/:recordId returns it on its own.
     */
    contentOmitted: boolean;
}

export type ArtefactRecordsView =
    | {
          available: true;
          artefactId: number;
          deleteAt: string | null;
          records: RecordView[];
          /** How many records came without their content (contentOmitted). */
          omitted: number;
      }
    | { available: false; artefactId: number; reason: "NOT_GRANTED" | "REVOKED" | "EXPIRED" | "ERASED" | "NOT_RECEIVED" };

/** What acceptPush answers the HIP with: 202 when the page was taken for processing. */
export interface PushAnswer {
    accepted: boolean;
    status: number;
    reason?: string;
}

/** An artefact as the data flow reads it. */
export interface HiuDataArtefact {
    id: number;
    consentArtefactId: string;
    /** ABDM's consent request id of the request that produced it (for the audit trail). */
    consentRequestId: string | null;
    hospitalId: number;
    /** The HIU id its consent request was raised as (X-HIU-ID, notifier.id); null when that request has none. */
    hiuId: string | null;
    hipId: string | null;
    status: string;
    /** The granted range and erase date, from on-fetch. */
    dateFrom: Date | null;
    dateTo: Date | null;
    dataEraseAt: Date | null;
    fetchedAt: Date | null;
    /** Granted care contexts as JSON, sealed at rest. */
    careContexts: string | null;
    recordsPurgedAt: Date | null;
}

export interface HiuDataRequestRow {
    id: number;
    hiRequestId: string;
    transactionId: string | null;
    artefactFk: number;
    hospitalId: number;
    dateFrom: Date;
    dateTo: Date;
    pushTokenHash: string;
    /** Sealed at rest; null once the transfer ends. */
    privateKey: string | null;
    nonce: string | null;
    keyExpiresAt: Date;
    transferDeadline: Date | null;
    sessionStatus: SessionStatus;
    pageCount: number | null;
    pagesReceived: number;
    /** Sealed JSON of the hiStatus reported per care context. */
    careContextStatus: string | null;
    notifiedAt: Date | null;
    notifyRequestId: string | null;
    error: string | null;
    createdAt: Date;
    completedAt: Date | null;
}

export type NewHiuDataRequest = Omit<HiuDataRequestRow, "id" | "createdAt" | "pagesReceived" | "pageCount" | "careContextStatus" | "notifiedAt" | "notifyRequestId" | "error" | "completedAt" | "transactionId">;

export type HiuDataRequestChanges = Partial<Pick<HiuDataRequestRow,
    "transactionId" | "privateKey" | "sessionStatus" | "careContextStatus" | "error" | "completedAt">>;

/** One entry of a page, ready to store. EntryIndex -1 marks a page that carried no entries. */
export interface NewHiuRecord {
    entryIndex: number;
    /** Sealed. */
    careContextReference: string | null;
    media: string | null;
    checksumOk: boolean;
    /** Sealed decrypted content; null when the entry failed. */
    content: string | null;
    deleteAt: Date | null;
}

export interface HiuRecordRow {
    id: number;
    dataRequestFk: number;
    pageNumber: number;
    entryIndex: number;
    careContextReference: string | null;
    media: string | null;
    checksumOk: boolean;
    content: string | null;
    receivedAt: Date;
    deleteAt: Date | null;
    /** True when listRecords left the content out to stay within its byte budget. */
    contentOmitted?: boolean;
}

/** What the data flow reads and writes in the clinic database. */
export interface HiuDataStore {
    findArtefact(artefactDbId: number): Promise<HiuDataArtefact | null>;
    /** The artefact's transfer that is still REQUESTED or RECEIVING, if any. */
    findOpenDataRequest(artefactDbId: number): Promise<HiuDataRequestRow | null>;
    /** True when a RECEIVED transfer of the artefact already holds entries (asking again would store them twice). */
    hasReceivedRecords(artefactDbId: number): Promise<boolean>;
    /** Stores a new transfer; a conflict HiuError when the artefact already has an open one (unique index). */
    createDataRequest(row: NewHiuDataRequest): Promise<number>;
    updateDataRequest(id: number, changes: HiuDataRequestChanges): Promise<void>;
    /**
     * Fails a request nothing has answered yet (no transaction id, still REQUESTED, notify unclaimed)
     * and drops its key. False when on-request or a push got there first.
     */
    failUnansweredRequest(id: number, input: { at: Date; error: string }): Promise<boolean>;
    /** Adds [bytes] to the transfer's BytesReceived only while the total stays within [maxBytes]. */
    reserveBytes(id: number, bytes: number, maxBytes: number): Promise<boolean>;
    findDataRequest(id: number): Promise<HiuDataRequestRow | null>;
    findDataRequestByHiRequestId(hiRequestId: string): Promise<HiuDataRequestRow | null>;
    findDataRequestByTokenHash(pushTokenHash: string): Promise<HiuDataRequestRow | null>;
    /**
     * Sets the transaction id when it is still empty (a push that beat on-request), only while the
     * transfer is open (REQUESTED or RECEIVING, notify unclaimed). False when it was not set.
     */
    adoptTransactionId(id: number, transactionId: string): Promise<boolean>;
    /**
     * Records pageCount when it is empty or equal, and moves REQUESTED to RECEIVING, atomically,
     * only while the transfer is open. False when the count disagrees or the transfer has ended.
     */
    claimPageCount(id: number, pageCount: number): Promise<boolean>;
    hasPage(dataRequestId: number, pageNumber: number): Promise<boolean>;
    /**
     * Stores a page's entries and adds one to PagesReceived in one transaction, only while the
     * artefact is GRANTED with its records not purged and the transfer is open (key held, notify
     * unclaimed); otherwise nothing is stored and [closed] is true. A page already stored (the
     * unique index on DataRequestFk, PageNumber, EntryIndex) changes nothing.
     */
    addPage(input: { dataRequestId: number; artefactFk: number; hospitalId: number; pageNumber: number; records: NewHiuRecord[] }): Promise<{ duplicate: boolean; closed?: boolean; pagesReceived: number }>;
    /** Sets NotifiedAt where it is still NULL. True for exactly one caller. */
    claimNotify(id: number, at: Date, notifyRequestId: string): Promise<boolean>;
    /** Each stored entry of a transfer (page markers excluded): its sealed reference and whether it decrypted and verified. */
    listEntryOutcomes(dataRequestId: number): Promise<{ careContextReference: string | null; ok: boolean }[]>;
    /**
     * The artefact's stored entries not yet past DeleteAt, in page and entry order, from one transfer
     * only: the latest RECEIVED one holding entries, else the latest holding entries. Content is
     * returned while the running total of stored content stays within [maxContentBytes]; past it,
     * content is null and contentOmitted true.
     */
    listRecords(artefactDbId: number, now: Date, maxContentBytes: number): Promise<HiuRecordRow[]>;
    /** One stored entry of the artefact (of the transfer listRecords shows), with its content, unless past DeleteAt. */
    findRecord(artefactDbId: number, recordId: number, now: Date): Promise<HiuRecordRow | null>;
}

type GatewayCall = Pick<AbdmGatewayService, "call">;

export interface HiuDataFlowCrypto {
    generateKeyMaterial(): HiuKeyMaterial;
    decryptEntry(input: { privateKey: Buffer; ourNonce: string; peerPublicKeyValue: string; peerNonce: string; content: string }): Buffer;
    verifyChecksum(plaintext: Buffer, checksum: unknown): void;
}

export interface HiuDataFlowSettings {
    transferWindowMinutes: number;
    /** Largest total entry content per transfer, in megabytes (ABDM_DATA_PUSH_MAX_TRANSFER_MB). */
    maxTransferMb?: number;
}

export interface HiuDataFlowDeps {
    store: HiuDataStore;
    audit: HiuAudit;
    gateway?: GatewayCall;
    clock?: () => number;
    crypto?: HiuDataFlowCrypto;
    /** The at-rest key set; null means not configured. */
    atRestKeys?: () => AtRestKeys | null;
    settings?: () => HiuDataFlowSettings;
    /** The records push base for the whole deployment; deploymentPushBaseUrl unless a test injects one. */
    pushBaseUrl?: () => Promise<string>;
    /** Runs a page's processing after acceptPush has answered. Tests pass one they can await. */
    runInBackground?: (task: () => Promise<void>) => void;
}

/** Path our dataPushUrl carries, after the push base (deploymentPushBaseUrl). The token follows. */
export const DATA_PUSH_PATH = "/api/v3/hiu/data-push/";
/** dhPublicKey.expiry: how long ABDM and the HIP may use our public key. */
export const HIU_KEY_LIFETIME_MS = 30 * 60_000;
/** Largest pageCount a transfer may announce. */
export const HIU_MAX_PAGE_COUNT = 200;
/** Largest entries[] on one page (a HIP is asked to send one per page). */
export const HIU_MAX_ENTRIES_PER_PAGE = 100;
/**
 * Most stored (sealed) content one records answer carries; records past it come without content,
 * to be read one at a time, so a large transfer is never opened into memory at once.
 */
export const HIU_RECORDS_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

const PUSH_TOKEN = /^[0-9a-f]{64}$/;
const NOT_FOUND: PushAnswer = { accepted: false, status: 404, reason: "Not found." };
const FINAL_SESSION_STATUSES: readonly SessionStatus[] = ["RECEIVED", "FAILED"];
const DESCRIPTIONS = {
    ok: "Data received successfully",
    errored: "Entry could not be decrypted or its checksum did not match",
    missing: "No entry received for this care context",
} as const;

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * The public origin HIPs push records to, one for the whole deployment: ABDM_DATA_PUSH_BASE_URL
 * when set, else the bridge URL ABDM already calls us on (AbdmSettings). Empty when neither is set.
 */
export const deploymentPushBaseUrl = async (bridge?: Pick<AbdmSettings, "bridgeUrl">): Promise<string> => {
    if (abdmConfig.dataPushBaseUrl) return abdmConfig.dataPushBaseUrl;
    // Loaded on first use, so this module loads without a database.
    return (bridge ?? (await import("../abdm-facilities.service.js")).abdmSettings).bridgeUrl();
};

const defaultSettings = (): HiuDataFlowSettings => ({
    transferWindowMinutes: abdmConfig.hiuTransferWindowMinutes,
    maxTransferMb: abdmConfig.dataPushMaxTransferMb,
});

/** Default when settings leave it out: ABDM_DATA_PUSH_MAX_TRANSFER_MB's own default. */
const DEFAULT_MAX_TRANSFER_MB = 100;

const defaultBackground = (task: () => Promise<void>): void => {
    setImmediate(() => {
        task().catch((error: any) => console.error(`[ABDM HIU] background data-push work failed: ${error?.code ?? error?.name ?? "error"}`));
    });
};

/** Staff and ABDM text never carries the word the frontend reads as its own login lapsing. */
const safeText = (text: string, length = 500): string => text.replace(/expired/gi, "lapsed").slice(0, length);

const isFinal = (row: HiuDataRequestRow): boolean => FINAL_SESSION_STATUSES.includes(row.sessionStatus) || row.notifiedAt !== null;

const iso = (date: Date | null): string | null => (date ? new Date(date).toISOString() : null);

/** Granted care-context references from an artefact's sealed CareContexts JSON. Empty when absent or unreadable. */
const grantedReferences = (sealed: string | null, keys: AtRestKeys): string[] => {
    if (!sealed) return [];
    try {
        const parsed = JSON.parse(open(sealed, keys).toString("utf8"));
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((item: any) => (typeof item === "string" ? item : item?.careContextReference))
            .filter((reference: unknown): reference is string => typeof reference === "string" && reference.length > 0);
    } catch {
        return [];
    }
};

const openText = (sealed: string | null, keys: AtRestKeys): string | null => {
    if (!sealed) return null;
    try {
        return open(sealed, keys).toString("utf8");
    } catch {
        return null;
    }
};

/** Checks a push body's shape without touching its content. Returns the reason it is refused, or null. */
const shapeProblem = (body: any): string | null => {
    if (!Number.isInteger(body.pageNumber) || body.pageNumber < 0) return "pageNumber must be a whole number, 0 or more.";
    if (!Number.isInteger(body.pageCount) || body.pageCount < 1) return "pageCount must be a whole number, 1 or more.";
    if (body.pageCount > HIU_MAX_PAGE_COUNT) return `pageCount may be at most ${HIU_MAX_PAGE_COUNT}.`;
    if (body.pageNumber > body.pageCount) return "pageNumber is beyond pageCount.";
    if (!Array.isArray(body.entries)) return "entries must be an array.";
    if (body.entries.length > HIU_MAX_ENTRIES_PER_PAGE) return `A page may carry at most ${HIU_MAX_ENTRIES_PER_PAGE} entries.`;
    if (body.entries.some((entry: unknown) => !entry || typeof entry !== "object")) return "Every entry must be an object.";
    const keyMaterial = body.keyMaterial;
    if (!keyMaterial || typeof keyMaterial !== "object") return "keyMaterial is required.";
    if (typeof keyMaterial.dhPublicKey?.keyValue !== "string" || !keyMaterial.dhPublicKey.keyValue) return "keyMaterial.dhPublicKey.keyValue is required.";
    if (typeof keyMaterial.nonce !== "string" || !keyMaterial.nonce) return "keyMaterial.nonce is required.";
    return null;
};

export class HiuDataFlowService implements HealthInformationRequester {
    private readonly store: HiuDataStore;
    private readonly audit: HiuAudit;
    private readonly gateway: GatewayCall;
    private readonly clock: () => number;
    private readonly crypto: HiuDataFlowCrypto;
    private readonly atRestKeys: () => AtRestKeys | null;
    private readonly settings: () => HiuDataFlowSettings;
    private readonly pushBaseUrl: () => Promise<string>;
    private readonly runInBackground: (task: () => Promise<void>) => void;

    constructor(deps: HiuDataFlowDeps) {
        this.store = deps.store;
        this.audit = deps.audit;
        this.gateway = deps.gateway ?? abdmGatewayService;
        this.clock = deps.clock ?? Date.now;
        this.crypto = deps.crypto ?? { generateKeyMaterial: fideliusKeyMaterial, decryptEntry: fideliusDecrypt, verifyChecksum: fideliusVerifyChecksum };
        this.atRestKeys = deps.atRestKeys ?? atRestKeysFromConfig;
        this.settings = deps.settings ?? defaultSettings;
        this.pushBaseUrl = deps.pushBaseUrl ?? deploymentPushBaseUrl;
        this.runInBackground = deps.runInBackground ?? defaultBackground;
    }

    // ---------------------------------------------------------------------------------------------
    // Health-information request

    /**
     * Asks ABDM for the records one artefact covers. Refused, with no call made, unless the
     * artefact is GRANTED, fetched, before its dataEraseAt, has no open transfer and no transfer
     * that already received its records. The row is
     * stored before the call, because on-request can arrive before the 202.
     */
    async requestForArtefact(artefactDbId: number, staffUserId?: string): Promise<void> {
        const settings = this.settings();
        const keys = this.atRestKeys();
        const pushBaseUrl = await this.pushBaseUrl();
        if (!pushBaseUrl || !keys) throw hiuNotConfiguredError();

        const artefact = await this.store.findArtefact(artefactDbId);
        if (!artefact) throw new HiuError("not-found", "That consent artefact was not found.");
        // Asked as the HIU its consent was raised as; never another hospital's, never a default.
        if (!artefact.hiuId) throw hiuFacilityNotConfiguredError();
        const now = new Date(this.clock());
        const refuse = async (error: HiuError): Promise<never> => {
            await this.audit.record({
                hospitalId: artefact.hospitalId,
                staffUserId: staffUserId ?? null,
                event: HIU_AUDIT_EVENTS.HI_REQUEST,
                consentRequestId: artefact.consentRequestId,
                artefactId: artefact.consentArtefactId,
                outcome: HIU_AUDIT_OUTCOMES.REJECTED,
                detail: error.kind,
            });
            throw error;
        };

        if (artefact.status !== "GRANTED") {
            return refuse(new HiuError("conflict", "Records can be requested only under a granted consent.", { details: { status: artefact.status } }));
        }
        if (!artefact.fetchedAt || !artefact.dateFrom || !artefact.dateTo || !artefact.dataEraseAt) {
            return refuse(new HiuError("conflict", "The consent's granted details have not arrived from ABDM yet."));
        }
        if (now.getTime() >= new Date(artefact.dataEraseAt).getTime()) {
            return refuse(new HiuError("conflict", "This consent is past its erase date, so no records can be requested."));
        }
        if (await this.store.findOpenDataRequest(artefact.id)) {
            return refuse(new HiuError("conflict", "Records are already being requested under this consent."));
        }
        if (await this.store.hasReceivedRecords(artefact.id)) {
            return refuse(new HiuError("conflict", "The records under this consent have already been received."));
        }

        // The pushToken authenticates the HIP's pushes; only its hash is stored.
        const pushToken = randomBytes(32).toString("hex");
        const dataPushUrl = `${pushBaseUrl}${DATA_PUSH_PATH}${pushToken}`;
        if (dataPushUrl.length > 255 || !isDataPushUrl(dataPushUrl)) {
            throw new HiuError("not-configured", "The records push address (ABDM_DATA_PUSH_BASE_URL, or the bridge URL) is too long or has characters ABDM does not allow.");
        }

        const keyMaterial = this.crypto.generateKeyMaterial();
        const keyExpiresAt = new Date(now.getTime() + HIU_KEY_LIFETIME_MS);
        const transferDeadline = new Date(now.getTime() + settings.transferWindowMinutes * 60_000);
        // The granted range exactly: ABDM refuses a wider one (ABDM-1063) and a narrower one would drop records.
        const dateFrom = new Date(artefact.dateFrom);
        const dateTo = new Date(artefact.dateTo);
        const hiRequestId = randomUUID();

        const dataRequestId = await this.store.createDataRequest({
            hiRequestId,
            artefactFk: artefact.id,
            hospitalId: artefact.hospitalId,
            dateFrom,
            dateTo,
            pushTokenHash: sha256Hex(pushToken),
            privateKey: seal(keyMaterial.privateKey, keys),
            nonce: keyMaterial.nonce,
            keyExpiresAt,
            transferDeadline,
            sessionStatus: "REQUESTED",
        });

        try {
            await this.gateway.call({
                operation: "data-flow/health-information/request",
                method: "POST",
                host: "gateway",
                path: "/api/hiecm/data-flow/v3/health-information/request",
                requestId: hiRequestId,
                headers: { "X-HIU-ID": artefact.hiuId },
                body: healthInformationRequestBody({
                    consentArtefactId: artefact.consentArtefactId,
                    dateFrom,
                    dateTo,
                    dataPushUrl,
                    keyMaterial,
                    keyExpiresAt,
                }),
            });
        } catch (error: any) {
            const code = error instanceof AbdmApiError ? error.code : null;
            const unknown = isOutcomeUnknown(error);
            if (unknown) {
                // No answer is not a refusal: ABDM may have taken the request, and its on-request and
                // the HIP's pages may still come. The row stays REQUESTED with its key; an on-request
                // error, or the transfer window (failTransfer, which notifies only a known
                // transaction), settles it.
                console.warn(`[ABDM HIU] health-information/request REQUEST-ID=${hiRequestId} got no answer (${error.kind}); left open for on-request`);
            } else {
                // A refusal: closed, unless on-request or a push already answered it.
                await this.store.failUnansweredRequest(dataRequestId, {
                    at: new Date(this.clock()),
                    error: safeText(error instanceof AbdmApiError
                        ? `ABDM did not accept the records request${code ? ` (${code})` : ""}: ${error.message}`
                        : "The records request could not be sent to ABDM."),
                });
            }
            await this.audit.record({
                hospitalId: artefact.hospitalId,
                staffUserId: staffUserId ?? null,
                event: HIU_AUDIT_EVENTS.HI_REQUEST,
                consentRequestId: artefact.consentRequestId,
                artefactId: artefact.consentArtefactId,
                requestId: hiRequestId,
                outcome: error instanceof AbdmApiError && error.kind === "rejected" ? HIU_AUDIT_OUTCOMES.REJECTED : HIU_AUDIT_OUTCOMES.FAILED,
                detail: unknown ? `${error.kind}, no answer` : code,
            });
            throw error;
        }

        await this.audit.record({
            hospitalId: artefact.hospitalId,
            staffUserId: staffUserId ?? null,
            event: HIU_AUDIT_EVENTS.HI_REQUEST,
            consentRequestId: artefact.consentRequestId,
            artefactId: artefact.consentArtefactId,
            requestId: hiRequestId,
            outcome: HIU_AUDIT_OUTCOMES.OK,
        });
        console.log(`[ABDM HIU] health-information/request sent for artefact ${artefact.consentArtefactId} REQUEST-ID=${hiRequestId}`);
    }

    // ---------------------------------------------------------------------------------------------
    // on-request

    /**
     * ABDM's answer to a health-information request: the transaction id the HIP will push under,
     * or an error, after which no data comes and the key is dropped. An unknown REQUEST-ID is
     * logged and dropped; a repeat changes nothing.
     */
    async onRequest(body: any, headers: CallbackHeaders): Promise<void> {
        const requestId = typeof body?.response?.requestId === "string" ? body.response.requestId : null;
        const row = requestId ? await this.store.findDataRequestByHiRequestId(requestId) : null;
        if (!row) {
            console.warn(`[ABDM HIU] on-request for an unknown request dropped REQUEST-ID=${headers?.requestId ?? "-"}`);
            await this.audit.record({ hospitalId: null, event: HIU_AUDIT_EVENTS.ON_REQUEST, requestId: headers?.requestId ?? null, outcome: HIU_AUDIT_OUTCOMES.IGNORED });
            return;
        }
        const artefact = await this.store.findArtefact(row.artefactFk);
        // Only from the HIU the request was raised as: one tenant's facility never settles another's transfer.
        if (!artefact?.hiuId || headers?.hiuId !== artefact.hiuId) {
            console.warn(`[ABDM HIU] on-request for another HIU dropped REQUEST-ID=${headers?.requestId ?? "-"}`);
            await this.audit.record({
                hospitalId: row.hospitalId,
                event: HIU_AUDIT_EVENTS.ON_REQUEST,
                requestId: row.hiRequestId,
                outcome: HIU_AUDIT_OUTCOMES.IGNORED,
                detail: "HIU mismatch",
            });
            return;
        }
        const auditBase = {
            hospitalId: row.hospitalId,
            event: HIU_AUDIT_EVENTS.ON_REQUEST,
            consentRequestId: artefact?.consentRequestId ?? null,
            artefactId: artefact?.consentArtefactId ?? null,
            requestId: row.hiRequestId,
        };

        const error = body?.error && typeof body.error === "object" ? body.error : null;
        const transactionId = typeof body?.hiRequest?.transactionId === "string" ? body.hiRequest.transactionId.trim() : "";
        if (error || !transactionId) {
            if (isFinal(row)) return;
            const code = typeof error?.code === "string" ? error.code.replace(/:\s*$/, "").trim() : null;
            await this.store.updateDataRequest(row.id, {
                sessionStatus: "FAILED",
                privateKey: null,
                completedAt: new Date(this.clock()),
                error: safeText(`ABDM refused the records request${code ? ` (${code})` : ""}${typeof error?.message === "string" ? `: ${error.message}` : "."}`),
            });
            await this.audit.record({ ...auditBase, outcome: HIU_AUDIT_OUTCOMES.REJECTED, detail: code });
            console.warn(`[ABDM HIU] on-request refused REQUEST-ID=${row.hiRequestId} code=${code ?? "-"}`);
            return;
        }

        if (row.transactionId && row.transactionId !== transactionId) {
            console.warn(`[ABDM HIU] on-request REQUEST-ID=${row.hiRequestId} names a different transaction; ignored`);
            await this.audit.record({ ...auditBase, transactionId, outcome: HIU_AUDIT_OUTCOMES.IGNORED, detail: "transaction mismatch" });
            return;
        }
        if (row.transactionId === transactionId) {
            // A repeat, or the push arrived first and adopted it.
            await this.audit.record({ ...auditBase, transactionId, outcome: HIU_AUDIT_OUTCOMES.IGNORED, detail: "repeat" });
            return;
        }
        if (isFinal(row)) {
            // The request was already closed (refused, or its window passed): no transfer is taken up on it.
            console.warn(`[ABDM HIU] on-request REQUEST-ID=${row.hiRequestId} transactionId=${transactionId} arrived for a request already ${row.sessionStatus}; not taken`);
            await this.audit.record({ ...auditBase, transactionId, outcome: HIU_AUDIT_OUTCOMES.IGNORED, detail: "request already closed" });
            return;
        }

        const abdmStatus = typeof body?.hiRequest?.sessionStatus === "string" ? body.hiRequest.sessionStatus.toUpperCase() : "";
        if (!(await this.store.adoptTransactionId(row.id, transactionId))) {
            // The request closed (or another transfer took the id) between the read above and the claim.
            console.warn(`[ABDM HIU] on-request REQUEST-ID=${row.hiRequestId}: transaction id not stored`);
            await this.audit.record({ ...auditBase, transactionId, outcome: HIU_AUDIT_OUTCOMES.IGNORED, detail: "request already closed" });
            return;
        }
        if (abdmStatus === "FAILED" && !isFinal(row)) {
            await this.store.updateDataRequest(row.id, { sessionStatus: "FAILED", privateKey: null, completedAt: new Date(this.clock()), error: "ABDM reported the records request as failed." });
        }
        await this.audit.record({ ...auditBase, transactionId, outcome: HIU_AUDIT_OUTCOMES.OK, detail: abdmStatus ? safeText(abdmStatus, 40) : null });
        console.log(`[ABDM HIU] on-request REQUEST-ID=${row.hiRequestId} transactionId=${transactionId} status=${abdmStatus || "-"}`);
    }

    // ---------------------------------------------------------------------------------------------
    // Data push

    /**
     * A HIP's page at our dataPushUrl. The token, transaction, window and shape are checked here,
     * before anything is decrypted; an accepted page is processed in the background so the HIP
     * gets its 202 at once. Answers never echo the body, and an unknown token reveals nothing.
     */
    async acceptPush(pushToken: string, body: any): Promise<PushAnswer> {
        const open = await this.openTransfer(pushToken);
        if ("answer" in open) return open.answer;
        const row = open.row;

        if (!body || typeof body !== "object" || Array.isArray(body)) return { accepted: false, status: 400, reason: "The body must be a JSON object." };
        const transactionId = typeof body.transactionId === "string" ? body.transactionId.trim() : "";
        if (!transactionId) return { accepted: false, status: 400, reason: "transactionId is required." };
        if (row.transactionId !== null && row.transactionId !== transactionId) {
            return { accepted: false, status: 400, reason: "transactionId does not match this push address." };
        }

        const problem = shapeProblem(body);
        if (problem) return { accepted: false, status: 400, reason: problem };

        if (row.transactionId === null && !(await this.store.adoptTransactionId(row.id, transactionId))) {
            const fresh = await this.store.findDataRequest(row.id);
            if (!fresh || fresh.transactionId !== transactionId) {
                return { accepted: false, status: 400, reason: "transactionId does not match this push address." };
            }
        }
        if (!(await this.store.claimPageCount(row.id, body.pageCount))) {
            return { accepted: false, status: 409, reason: "pageCount differs from earlier pages, or the transfer has ended." };
        }
        // A page already stored (the HIP sending it again) is answered as taken, and not counted twice.
        if (await this.store.hasPage(row.id, body.pageNumber)) return { accepted: true, status: 202 };
        // The whole transfer is capped, not only each page, so one consent cannot fill the database.
        const maxMb = this.settings().maxTransferMb ?? DEFAULT_MAX_TRANSFER_MB;
        const bytes = (body.entries as any[]).reduce((total: number, entry: any) => total + (typeof entry.content === "string" ? entry.content.length : 0), 0);
        if (!(await this.store.reserveBytes(row.id, bytes, Math.floor(maxMb * 1024 * 1024)))) {
            return { accepted: false, status: 413, reason: `This transfer is larger than this HIU accepts (${maxMb} MB in all).` };
        }

        const page = {
            pageNumber: body.pageNumber as number,
            pageCount: body.pageCount as number,
            entries: body.entries as any[],
            peerPublicKeyValue: body.keyMaterial.dhPublicKey.keyValue as string,
            peerNonce: body.keyMaterial.nonce as string,
        };
        this.runInBackground(() => this.processPage(row.id, transactionId, page));
        return { accepted: true, status: 202 };
    }

    /**
     * What a push can be refused for before its body is read (the push route runs this ahead of its
     * JSON parser): the token's form, an unknown token, a transfer that has ended or whose window has
     * closed. Null when the transfer is open. acceptPush checks all of it again.
     */
    async pushAddressProblem(pushToken: string): Promise<PushAnswer | null> {
        const open = await this.openTransfer(pushToken);
        return "answer" in open ? open.answer : null;
    }

    /** The open transfer behind a push token, or the answer that refuses the push. */
    private async openTransfer(pushToken: string): Promise<{ row: HiuDataRequestRow } | { answer: PushAnswer }> {
        if (typeof pushToken !== "string" || !PUSH_TOKEN.test(pushToken)) return { answer: NOT_FOUND };
        if (!this.atRestKeys()) return { answer: { accepted: false, status: 503, reason: "Not accepting records at the moment." } };

        const row = await this.store.findDataRequestByTokenHash(sha256Hex(pushToken));
        if (!row) return { answer: NOT_FOUND };
        if (isFinal(row) || !row.privateKey) return { answer: { accepted: false, status: 409, reason: "This transfer has already ended." } };

        const deadline = Math.min(new Date(row.keyExpiresAt).getTime(), row.transferDeadline ? new Date(row.transferDeadline).getTime() : Infinity);
        if (this.clock() >= deadline) return { answer: { accepted: false, status: 410, reason: "The window for this transfer has closed." } };
        return { row };
    }

    /** Decrypts, verifies and stores one accepted page, then completes the transfer if it was the last. */
    private async processPage(
        dataRequestId: number,
        transactionId: string,
        page: { pageNumber: number; pageCount: number; entries: any[]; peerPublicKeyValue: string; peerNonce: string },
    ): Promise<void> {
        const label = `transactionId=${transactionId} page ${page.pageNumber} of ${page.pageCount}`;
        const keys = this.atRestKeys();
        const row = await this.store.findDataRequest(dataRequestId);
        if (!keys || !row || !row.privateKey || !row.nonce || isFinal(row)) {
            console.warn(`[ABDM HIU] data push ${label}: transfer no longer open; page dropped`);
            return;
        }
        if (await this.store.hasPage(row.id, page.pageNumber)) {
            console.log(`[ABDM HIU] data push ${label}: duplicate page ignored`);
            return;
        }
        const artefact = await this.store.findArtefact(row.artefactFk);
        const deleteAt = artefact?.dataEraseAt ?? null;

        let privateKey: Buffer;
        try {
            privateKey = open(row.privateKey, keys);
        } catch (error: any) {
            console.error(`[ABDM HIU] data push ${label}: stored key unreadable (${error?.reason ?? "error"})`);
            return;
        }

        let failed = 0;
        let notJson = 0;
        const records: NewHiuRecord[] = page.entries.map((entry, entryIndex) => {
            const reference = typeof entry.careContextReference === "string" && entry.careContextReference ? entry.careContextReference : null;
            const media = typeof entry.media === "string" ? entry.media.slice(0, 100) : null;
            const sealedReference = reference ? seal(reference, keys) : null;
            const failedRecord = (): NewHiuRecord => {
                failed += 1;
                return { entryIndex, careContextReference: sealedReference, media, checksumOk: false, content: null, deleteAt };
            };
            // A link entry (no inline content) is not fetched: the spec defines no field for it.
            if (typeof entry.content !== "string" || !entry.content) return failedRecord();
            try {
                const plaintext = this.crypto.decryptEntry({
                    privateKey,
                    ourNonce: row.nonce!,
                    peerPublicKeyValue: page.peerPublicKeyValue,
                    peerNonce: page.peerNonce,
                    content: entry.content,
                });
                this.crypto.verifyChecksum(plaintext, entry.checksum);
                if ((media ?? HIU_ENTRY_MEDIA).toLowerCase().includes("json")) {
                    try {
                        JSON.parse(plaintext.toString("utf8"));
                    } catch {
                        notJson += 1;
                    }
                }
                return { entryIndex, careContextReference: sealedReference, media, checksumOk: true, content: seal(plaintext, keys), deleteAt };
            } catch (error) {
                if (!(error instanceof HiuCryptoError)) throw error;
                return failedRecord();
            }
        });
        privateKey.fill(0);

        // A page with no entries still counts toward pageCount: it is stored as a marker row.
        const toStore = records.length > 0 ? records : [{ entryIndex: -1, careContextReference: null, media: null, checksumOk: false, content: null, deleteAt }];
        const stored = await this.store.addPage({ dataRequestId: row.id, artefactFk: row.artefactFk, hospitalId: row.hospitalId, pageNumber: page.pageNumber, records: toStore });
        if (stored.duplicate) {
            console.log(`[ABDM HIU] data push ${label}: duplicate page ignored`);
            return;
        }
        if (stored.closed) {
            // Revoked, lapsed or timed out while this page was being decrypted: nothing was stored.
            console.warn(`[ABDM HIU] data push ${label}: transfer closed while the page was processed; page dropped`);
            return;
        }

        const auditBase = {
            hospitalId: row.hospitalId,
            consentRequestId: artefact?.consentRequestId ?? null,
            artefactId: artefact?.consentArtefactId ?? null,
            transactionId,
        };
        const detail = `page ${page.pageNumber} of ${page.pageCount}, ${records.length} entries, ${failed} failed${notJson ? `, ${notJson} not JSON` : ""}`;
        await this.audit.record({ ...auditBase, event: HIU_AUDIT_EVENTS.PAGE_RECEIVED, outcome: failed ? HIU_AUDIT_OUTCOMES.FAILED : HIU_AUDIT_OUTCOMES.OK, detail });
        if (failed) {
            await this.audit.record({ ...auditBase, event: HIU_AUDIT_EVENTS.DECRYPT_FAIL, outcome: HIU_AUDIT_OUTCOMES.FAILED, detail: `page ${page.pageNumber}: ${failed} of ${records.length} entries` });
        }
        console.log(`[ABDM HIU] data push ${label}: ${records.length} entries, ${failed} failed; ${stored.pagesReceived} of ${page.pageCount} pages in`);

        if (stored.pagesReceived >= page.pageCount) {
            await this.completeTransfer(row.id, "complete");
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Completion and timeout

    /**
     * Fails a transfer that passed its window (the maintenance sweep calls this). Only the caller
     * that claims the notify acts, so several instances can sweep at once.
     */
    async failTransfer(dataRequestId: number): Promise<void> {
        await this.completeTransfer(dataRequestId, "timeout");
    }

    /**
     * Claims the transfer's one notify, settles its status, drops our private key, then sends
     * health-information/notify: RECEIVED when every stored entry decrypted and verified, else
     * FAILED; hiStatus per care context, with granted care contexts that sent nothing ERRORED.
     */
    private async completeTransfer(dataRequestId: number, reason: "complete" | "timeout"): Promise<void> {
        const notifyRequestId = randomUUID();
        const now = new Date(this.clock());
        if (!(await this.store.claimNotify(dataRequestId, now, notifyRequestId))) return;

        const row = await this.store.findDataRequest(dataRequestId);
        if (!row) return;
        const artefact = await this.store.findArtefact(row.artefactFk);
        const keys = this.atRestKeys();
        const settings = this.settings();
        const auditBase = {
            hospitalId: row.hospitalId,
            consentRequestId: artefact?.consentRequestId ?? null,
            artefactId: artefact?.consentArtefactId ?? null,
            transactionId: row.transactionId,
        };

        if (reason === "timeout") {
            await this.audit.record({ ...auditBase, event: HIU_AUDIT_EVENTS.TRANSFER_TIMEOUT, outcome: HIU_AUDIT_OUTCOMES.FAILED, detail: `${row.pagesReceived} of ${row.pageCount ?? "?"} pages` });
        }

        // Per care context: OK only when every entry it sent decrypted and verified.
        const outcomes = await this.store.listEntryOutcomes(row.id);
        const byReference = new Map<string, HiuHiStatus>();
        let entryFailed = false;
        let entryOk = false;
        for (const outcome of outcomes) {
            if (outcome.ok) entryOk = true;
            else entryFailed = true;
            const reference = keys ? openText(outcome.careContextReference, keys) : null;
            if (!reference) continue;
            byReference.set(reference, !outcome.ok || byReference.get(reference) === "ERRORED" ? "ERRORED" : "OK");
        }
        const statusResponses: { careContextReference: string; hiStatus: HiuHiStatus; description: string }[] = [...byReference].map(([careContextReference, hiStatus]) => ({
            careContextReference,
            hiStatus,
            description: hiStatus === "OK" ? DESCRIPTIONS.ok : DESCRIPTIONS.errored,
        }));
        for (const reference of keys && artefact ? grantedReferences(artefact.careContexts, keys) : []) {
            if (!byReference.has(reference)) {
                statusResponses.push({ careContextReference: reference, hiStatus: "ERRORED", description: DESCRIPTIONS.missing });
            }
        }

        const sessionStatus: HiuNotifySessionStatus = reason === "complete" && entryOk && !entryFailed ? "RECEIVED" : "FAILED";
        const error = sessionStatus === "RECEIVED"
            ? null
            : reason === "timeout"
              ? `The provider did not send every page within ${settings.transferWindowMinutes} minutes (${row.pagesReceived} of ${row.pageCount ?? "?"} received).`
              : entryOk
                ? "Some entries could not be decrypted or failed their checksum."
                : "No entry could be decrypted and verified.";

        await this.store.updateDataRequest(row.id, {
            sessionStatus,
            privateKey: null,
            completedAt: now,
            error,
            careContextStatus: keys ? seal(JSON.stringify(statusResponses.map(({ careContextReference, hiStatus }) => ({ careContextReference, hiStatus }))), keys) : null,
        });

        if (!row.transactionId) {
            // ABDM never acknowledged the request, so there is no transaction to report on.
            console.warn(`[ABDM HIU] transfer for REQUEST-ID=${row.hiRequestId} closed ${sessionStatus} without a transaction id; no notify sent`);
            return;
        }
        const hiuId = artefact?.hiuId;
        if (!hiuId) {
            console.warn(`[ABDM HIU] transfer transactionId=${row.transactionId} closed ${sessionStatus}; HIU id missing, no notify sent`);
            return;
        }

        try {
            await this.gateway.call({
                operation: "data-flow/health-information/notify",
                method: "POST",
                host: "gateway",
                path: "/api/hiecm/data-flow/v3/health-information/notify",
                requestId: notifyRequestId,
                body: {
                    notification: {
                        consentId: artefact?.consentArtefactId ?? "",
                        transactionId: row.transactionId,
                        doneAt: abdmDateTime(now),
                        notifier: { type: "HIU", id: hiuId },
                        statusNotification: {
                            sessionStatus,
                            hipId: artefact?.hipId ?? "",
                            statusResponses,
                        },
                    },
                },
            });
            await this.audit.record({ ...auditBase, event: HIU_AUDIT_EVENTS.DATA_NOTIFY_SENT, requestId: notifyRequestId, outcome: sessionStatus, detail: `${statusResponses.length} care contexts` });
            console.log(`[ABDM HIU] health-information/notify transactionId=${row.transactionId} ${sessionStatus} REQUEST-ID=${notifyRequestId}`);
        } catch (error: any) {
            const code = error instanceof AbdmApiError ? error.code : null;
            await this.audit.record({ ...auditBase, event: HIU_AUDIT_EVENTS.DATA_NOTIFY_SENT, requestId: notifyRequestId, outcome: HIU_AUDIT_OUTCOMES.FAILED, detail: code });
            console.error(`[ABDM HIU] health-information/notify transactionId=${row.transactionId} not sent: ${code ?? error?.kind ?? "error"}`);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Staff read

    /**
     * An artefact's decrypted records for staff of its hospital. Checked on every read: the
     * artefact must be GRANTED and before its dataEraseAt. Audited as RECORD_VIEWED.
     */
    async records(ctx: StaffContext, artefactDbId: number): Promise<ArtefactRecordsView> {
        const readable = await this.readableArtefact(ctx, artefactDbId);
        if ("view" in readable) return readable.view;
        const { artefact, keys, now } = readable;

        // Content only up to a fixed size per answer: the rest is read one record at a time.
        const rows = await this.store.listRecords(artefact.id, now, HIU_RECORDS_RESPONSE_MAX_BYTES);
        if (rows.length === 0) return { available: false, artefactId: artefact.id, reason: "NOT_RECEIVED" };
        const records = this.recordViews(artefact, rows, keys);
        const omitted = records.filter((record) => record.contentOmitted).length;

        await this.audit.record({
            hospitalId: artefact.hospitalId,
            staffUserId: ctx.staffUserId,
            event: HIU_AUDIT_EVENTS.RECORD_VIEWED,
            consentRequestId: artefact.consentRequestId,
            artefactId: artefact.consentArtefactId,
            outcome: HIU_AUDIT_OUTCOMES.OK,
            detail: `${records.length} records${omitted ? `, ${omitted} without content` : ""}`,
        });
        return { available: true, artefactId: artefact.id, deleteAt: iso(artefact.dataEraseAt), records, omitted };
    }

    /** One record with its content (one the list left out), under the same checks as records(). */
    async record(ctx: StaffContext, artefactDbId: number, recordId: number): Promise<ArtefactRecordsView> {
        const readable = await this.readableArtefact(ctx, artefactDbId);
        if ("view" in readable) return readable.view;
        const { artefact, keys, now } = readable;

        const row = Number.isInteger(recordId) && recordId > 0 ? await this.store.findRecord(artefact.id, recordId, now) : null;
        if (!row) throw new HiuError("not-found", "That record was not found under this consent.");
        const records = this.recordViews(artefact, [row], keys);

        await this.audit.record({
            hospitalId: artefact.hospitalId,
            staffUserId: ctx.staffUserId,
            event: HIU_AUDIT_EVENTS.RECORD_VIEWED,
            consentRequestId: artefact.consentRequestId,
            artefactId: artefact.consentArtefactId,
            outcome: HIU_AUDIT_OUTCOMES.OK,
            detail: `record ${row.id}`,
        });
        return { available: true, artefactId: artefact.id, deleteAt: iso(artefact.dataEraseAt), records, omitted: 0 };
    }

    /**
     * Staff asking for the records again under a granted artefact of their hospital, after a
     * transfer failed or a first request never went out. requestForArtefact refuses anything not
     * GRANTED, unfetched, past its dataEraseAt, with a transfer still open or with its records
     * already received; ABDM enforces the
     * consent's frequency, and its refusal is passed on, never retried here.
     */
    async requestRecords(ctx: StaffContext, artefactDbId: number): Promise<{ artefactId: number }> {
        const artefact = Number.isInteger(artefactDbId) && artefactDbId > 0 ? await this.store.findArtefact(artefactDbId) : null;
        // Another hospital's artefact is "not found", never "forbidden": its existence is not revealed.
        if (!artefact || artefact.hospitalId !== ctx.hospitalId) throw new HiuError("not-found", "That consent artefact was not found.");
        await this.requestForArtefact(artefact.id, ctx.staffUserId);
        return { artefactId: artefact.id };
    }

    /**
     * The artefact when its records may be read by [ctx] now, with the keys and time to read them;
     * else the unavailable answer. Another hospital's artefact is "not found", never "forbidden".
     */
    private async readableArtefact(ctx: StaffContext, artefactDbId: number): Promise<{ artefact: HiuDataArtefact; keys: AtRestKeys; now: Date } | { view: ArtefactRecordsView }> {
        const artefact = Number.isInteger(artefactDbId) ? await this.store.findArtefact(artefactDbId) : null;
        if (!artefact || artefact.hospitalId !== ctx.hospitalId) throw new HiuError("not-found", "That consent artefact was not found.");
        const keys = this.atRestKeys();
        if (!keys) throw hiuNotConfiguredError();

        const now = new Date(this.clock());
        const unavailable = (reason: "NOT_GRANTED" | "REVOKED" | "EXPIRED" | "ERASED"): { view: ArtefactRecordsView } => ({ view: { available: false, artefactId: artefact.id, reason } });
        if (artefact.status === "REVOKED") return unavailable("REVOKED");
        if (artefact.status === "EXPIRED") return unavailable("EXPIRED");
        if (artefact.status !== "GRANTED") return unavailable("NOT_GRANTED");
        if (artefact.recordsPurgedAt || (artefact.dataEraseAt && now.getTime() >= new Date(artefact.dataEraseAt).getTime())) return unavailable("ERASED");
        return { artefact, keys, now };
    }

    private recordViews(artefact: HiuDataArtefact, rows: HiuRecordRow[], keys: AtRestKeys): RecordView[] {
        let unreadable = 0;
        const records = rows.map((row) => {
            let bundle: unknown | null = null;
            let raw: string | null = null;
            if (row.content) {
                try {
                    const plain = open(row.content, keys);
                    const text = plain.toString("utf8");
                    try {
                        bundle = JSON.parse(text);
                    } catch {
                        // Not JSON: show it as text, unless it is binary.
                        raw = text.includes("�") ? null : text;
                    }
                } catch {
                    unreadable += 1;
                }
            }
            return {
                id: row.id,
                pageNumber: row.pageNumber,
                entryIndex: row.entryIndex,
                careContextReference: openText(row.careContextReference, keys),
                media: row.media,
                checksumOk: row.checksumOk,
                receivedAt: new Date(row.receivedAt).toISOString(),
                bundle,
                raw,
                contentOmitted: row.contentOmitted === true,
            };
        });
        if (unreadable) console.warn(`[ABDM HIU] artefact ${artefact.consentArtefactId}: ${unreadable} stored records could not be opened`);
        return records;
    }
}

/**
 * The health-information/request body (M3 spec L1037-1140). The nonce goes in keyMaterial, where
 * the HIP reads it (the M2 copy CM forwards defines it only there), and also at hiRequest level,
 * because the M3 schema's hiRequest.required lists it there and the abdm-docs validator refuses
 * the body without it. Both carry the same value.
 */
export const healthInformationRequestBody = (input: {
    consentArtefactId: string;
    dateFrom: Date;
    dateTo: Date;
    dataPushUrl: string;
    keyMaterial: Pick<HiuKeyMaterial, "publicKeyValue" | "nonce">;
    keyExpiresAt: Date;
}) => ({
    hiRequest: {
        consent: { id: input.consentArtefactId },
        dateRange: { from: abdmDateTime(input.dateFrom), to: abdmDateTime(input.dateTo) },
        dataPushUrl: input.dataPushUrl,
        keyMaterial: {
            cryptoAlg: KEY_MATERIAL_CRYPTO_ALG,
            curve: KEY_MATERIAL_CURVE,
            dhPublicKey: {
                expiry: abdmDateTime(input.keyExpiresAt),
                parameters: KEY_MATERIAL_PARAMETERS,
                keyValue: input.keyMaterial.publicKeyValue,
            },
            nonce: input.keyMaterial.nonce,
        },
        nonce: input.keyMaterial.nonce,
    },
});
