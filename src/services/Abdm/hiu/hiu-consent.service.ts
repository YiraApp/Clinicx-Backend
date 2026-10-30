import { randomUUID } from "crypto";
import { abdmConfig, isDataPushBase } from "../../../config/abdm.config.js";
import { hiuAuditRepository } from "../../../repositories/Abdm/hiu-audit.repository.js";
import type { AbdmFacilityDirectory, Hiu } from "../abdm-facilities.service.js";
import { AbdmApiError, abdmGatewayService, isOutcomeUnknown, normalizeAbdmCode, type AbdmGatewayService } from "../abdm-gateway.service.js";
import { atRestKeysFromConfig, seal, type AtRestKeys } from "./hiu-at-rest.js";
import { HIU_AUDIT_EVENTS, HIU_AUDIT_OUTCOMES, notifyAuditEvent, type HiuAudit } from "./hiu-audit.js";
import { errorCodeOf, RecordPurgeError } from "./hiu-db-errors.js";
import { deploymentPushBaseUrl } from "./hiu-data-flow.service.js";
import {
    HIU_ACCESS_MODES,
    HIU_DEFAULT_FREQUENCY,
    HIU_HI_TYPES,
    HIU_PURPOSES,
    HIU_PURPOSE_REF_URI,
    HiuError,
    abdmDateTime,
    hiuFacilityNotConfiguredError,
    hiuNotConfiguredError,
    isAbhaAddress,
    isAccessMode,
    isArtefactStatus,
    isDateOnly,
    isFrequencyUnit,
    isHiType,
    isNotifyConsentStatus,
    isPurposeCode,
    parseDateTime,
    parseHiTypes,
    purposeText,
    type ArtefactStage,
    type ArtefactStatus,
    type ConsentStatus,
    type NotifyConsentStatus,
} from "./hiu-enums.js";

/**
 * ABDM Milestone 3, the consent half of ClinicX as a Health Information User (plan sections 3, 7, 9):
 *
 *   staff form  ──► consent/request/init (REQUEST-ID stored first)      ──► on-init: ABDM's consentRequestId
 *   patient decides in their ABHA app                                   ──► notify: GRANTED + every artefact id,
 *                                                                           DENIED, EXPIRED or REVOKED
 *   we acknowledge on hiu/on-notify (one entry per artefact), then for EACH granted artefact
 *   consent/fetch (REQUEST-ID stored first)                             ──► on-fetch: what was granted
 *   and hand the artefact to the data-flow service (HealthInformationRequester).
 *
 * Per tenant: a request is raised as its hospital's HIU id (AbdmFacilities: HiuId, else HipId),
 * stored on the row; status, fetch and the data flow then use the row's id, and a callback is
 * taken only when its X-HIU-ID is that same id. A hospital without one cannot raise requests.
 *
 * Every callback answer is matched to the REQUEST-ID we stored before the call; anything unknown is
 * logged and dropped. Callbacks can repeat and arrive out of order, so every handler is idempotent and
 * no handler throws. Logs carry ids, statuses and counts: never ABHA addresses, care-context
 * references, keys or tokens.
 */

// ---- Staff API types (contract "Staff API") ----

export type { ArtefactStage } from "./hiu-enums.js";

export type StaffContext = { staffUserId: string; hospitalId: number; organizationId: number | null };
export type CallbackHeaders = { requestId: string | null; hiuId: string | null; timestamp: string | null };

export interface HiuOptions {
    /** The server can act as an HIU and this hospital has an HIU id. */
    configured: boolean;
    /** Why not, for staff; only when configured is false. */
    reason?: string;
    purposes: { code: string; text: string }[];
    hiTypes: { code: string; label: string }[];
    accessModes: string[];
    defaults: { purpose: "CAREMGT"; accessMode: "VIEW" };
}

export interface PatientAbhaView {
    userId: string;
    name: string;
    abhaAddress: string | null;
    abhaNumberMasked: string | null;
}

export interface NewConsentRequestInput {
    patientUserId: string;
    purposeCode: string;
    hiTypes: string[];
    /** YYYY-MM-DD, the clinic's calendar day (IST). */
    dateFrom: string;
    dateTo: string;
    /** ISO date-time with a zone: when the records must be deleted (the form's "consent expiry", plan D7). */
    dataEraseAt: string;
    accessMode: string;
}

export interface ConsentRequestSummary {
    id: number;
    status: ConsentStatus;
    statusAt: string;
    createdAt: string;
    /** ABDM's id, once on-init arrives. */
    consentRequestId: string | null;
    /** The REQUEST-ID our consent/request/init went out with: what staff quote to NHA about this request. */
    initRequestId: string;
    /** abhaNumberMasked: the patient's current ABHA number with only its last 4 digits shown, or null. */
    patient: { userId: string; name: string; abhaAddress: string; abhaNumberMasked: string | null };
    purposeCode: string;
    hiTypes: string[];
    /** YYYY-MM-DD, as the staff member entered them (clinic calendar days). */
    dateFrom: string;
    dateTo: string;
    /** ISO date-time. */
    dataEraseAt: string;
    accessMode: string;
    staffName: string | null;
    /** requestId: the init REQUEST-ID (as initRequestId), to quote to NHA. */
    abdmError: { code: string | null; message: string; requestId: string } | null;
    artefactCount: number;
}

export interface ArtefactView {
    id: number;
    consentArtefactId: string;
    status: "GRANTED" | "REVOKED" | "EXPIRED" | "DENIED";
    statusAt: string;
    hip: { id: string; name: string | null } | null;
    /** What the patient granted (ISO date-times), which may differ from what was asked. Null until on-fetch. */
    granted: { hiTypes: string[]; dateFrom: string; dateTo: string; dataEraseAt: string | null; accessMode: string | null } | null;
    stage: ArtefactStage;
    transfer: { pagesReceived: number; pageCount: number | null; error: string | null; requestedAt: string | null; completedAt: string | null } | null;
    recordCount: number;
}

export interface ConsentRequestDetail extends ConsentRequestSummary {
    artefacts: ArtefactView[];
    /** The request's audit trail: event names and outcomes only, no patient data. */
    events: { at: string; event: string; outcome: string }[];
}

/** Implemented by the data-flow service: asks the HIP for the records of one granted artefact. */
export interface HealthInformationRequester {
    /** [staffUserId] is set when a staff member asked again, for the audit trail. */
    requestForArtefact(artefactDbId: number, staffUserId?: string): Promise<void>;
}

// ---- What the consent side reads and writes (implemented by HiuConsentRepository) ----

export interface ConsentRequestRow {
    id: number;
    initRequestId: string;
    consentRequestId: string | null;
    statusRequestId: string | null;
    hospitalId: number;
    /** The HIU id the request was raised as (X-HIU-ID of every later call about it); null only on a request from before it was stored. */
    hiuId: string | null;
    organizationId: number | null;
    staffUserId: string;
    staffName: string | null;
    patientUserId: string;
    /** From Users, for display; null when the patient record is gone. */
    patientName: string | null;
    /** From Users (unmasked; the summary masks it); null or absent when unknown. */
    patientAbhaNumber?: string | null;
    abhaAddress: string;
    purposeCode: string;
    hiTypes: string[];
    /** Requested range as sent (instants). */
    dateFrom: Date;
    dateTo: Date;
    dataEraseAt: Date;
    accessMode: string;
    status: ConsentStatus;
    statusAt: Date;
    abdmErrorCode: string | null;
    abdmError: string | null;
    createdAt: Date;
    artefactCount: number;
}

export type NewConsentRequestRow = Omit<
    ConsentRequestRow,
    "id" | "createdAt" | "patientName" | "patientAbhaNumber" | "artefactCount" | "consentRequestId" | "statusRequestId" | "abdmErrorCode" | "abdmError"
>;

export type ConsentRequestChanges = Partial<Pick<ConsentRequestRow, "consentRequestId" | "statusRequestId" | "status" | "statusAt" | "abdmErrorCode" | "abdmError">>;

export interface ArtefactRow {
    id: number;
    consentArtefactId: string;
    consentRequestFk: number;
    hospitalId: number;
    hipId: string | null;
    hipName: string | null;
    status: ArtefactStatus;
    statusAt: Date;
    /** Granted terms, null until on-fetch. */
    hiTypes: string[] | null;
    dateFrom: Date | null;
    dateTo: Date | null;
    dataEraseAt: Date | null;
    accessMode: string | null;
    fetchRequestId: string | null;
    fetchedAt: Date | null;
    recordsPurgedAt: Date | null;
}

/** The artefact's latest health-information request (AbdmHiuDataRequests), as the stage needs it. */
export interface TransferRow {
    transactionId: string | null;
    sessionStatus: string;
    pageCount: number | null;
    pagesReceived: number;
    error: string | null;
    requestedAt: Date | null;
    completedAt: Date | null;
}

export interface ArtefactWithTransfer extends ArtefactRow {
    transfer: TransferRow | null;
    recordCount: number;
}

/** What on-fetch granted, ready to store. careContexts is already sealed. */
export interface FetchedDetail {
    hipId: string | null;
    hipName: string | null;
    hiTypes: string[];
    dateFrom: Date | null;
    dateTo: Date | null;
    dataEraseAt: Date | null;
    accessMode: string | null;
    /** JSON { unit, value, repeats }. */
    frequency: string | null;
    careContexts: string | null;
    signature: string | null;
    fetchedAt: Date;
}

export interface HiuConsentStore {
    /**
     * The patient, only when they are a patient of [hospitalId] as the patient list shows them: a live
     * registration and an active Patient role, the registration or the role at [hospitalId].
     */
    findPatient(userId: string, hospitalId: number): Promise<{ userId: string; name: string; abhaAddress: string | null; abhaNumber: string | null } | null>;
    staffName(userId: string): Promise<string | null>;
    /** This hospital's SENDING or REQUESTED requests for the patient and purpose. */
    findOpenRequests(input: { hospitalId: number; patientUserId: string; purposeCode: string }): Promise<ConsentRequestRow[]>;
    /**
     * Runs [work] holding a lock on the hospital, patient and purpose, across instances, so the open
     * request check and the insert after it cannot interleave with another raise for the same need.
     */
    withOpenRequestLock<T>(key: { hospitalId: number; patientUserId: string; purposeCode: string }, work: () => Promise<T>): Promise<T>;
    createRequest(row: NewConsentRequestRow): Promise<number>;
    updateRequest(id: number, changes: ConsentRequestChanges): Promise<void>;
    /** Applies [changes] only while the request is still SENDING with no ABDM id (on-init has not answered); false otherwise. */
    updateSendingRequest(id: number, changes: ConsentRequestChanges): Promise<boolean>;
    /** Marks FAILED, with [message], every SENDING request without an ABDM id created at or before [createdBefore]. */
    failStaleSending(input: { createdBefore: Date; at: Date; message: string }): Promise<{ id: number; hospitalId: number; initRequestId: string }[]>;
    /** Staff read: only within [hospitalId]. */
    findRequest(hospitalId: number, id: number): Promise<ConsentRequestRow | null>;
    findRequestById(id: number): Promise<ConsentRequestRow | null>;
    findRequestByInitRequestId(requestId: string): Promise<ConsentRequestRow | null>;
    findRequestByStatusRequestId(requestId: string): Promise<ConsentRequestRow | null>;
    findRequestByConsentRequestId(consentRequestId: string): Promise<ConsentRequestRow | null>;
    /** Newest first. */
    listRequests(input: { hospitalId: number; page: number; pageSize: number; status?: string }): Promise<{ rows: ConsentRequestRow[]; total: number }>;
    listArtefacts(consentRequestFk: number): Promise<ArtefactWithTransfer[]>;
    findArtefactsByConsentArtefactIds(ids: string[]): Promise<ArtefactRow[]>;
    findArtefactByFetchRequestId(requestId: string): Promise<ArtefactRow | null>;
    /**
     * Stores each id not yet stored, as [status] (GRANTED when omitted; an ended one also gets
     * RecordsPurgedAt). A repeat (or a concurrent duplicate) adds nothing.
     */
    addArtefacts(input: { consentRequestFk: number; hospitalId: number; consentArtefactIds: string[]; at: Date; status?: "GRANTED" | "REVOKED" | "EXPIRED" }): Promise<void>;
    /**
     * Sets FetchRequestId (and counts the attempt) only while it is null and the artefact is GRANTED
     * and not fetched; false when another fetch holds it.
     */
    claimFetch(artefactId: number, requestId: string, at: Date): Promise<boolean>;
    /** Clears FetchRequestId when it still equals [requestId] (ABDM refused the fetch call). */
    releaseFetch(artefactId: number, requestId: string): Promise<void>;
    /**
     * GRANTED artefacts whose details never came: not fetched, fewer than [maxAttempts] fetches, and
     * untouched since [staleBefore] (their fetch was released, or its on-fetch never arrived).
     */
    listFetchRetries(input: { staleBefore: Date; maxAttempts: number; limit: number }): Promise<ArtefactRow[]>;
    /**
     * Swaps FetchRequestId from [previousRequestId] (null: released) to [requestId] and counts the
     * attempt, atomically, only while listFetchRetries' conditions still hold; false otherwise.
     */
    reclaimFetch(input: { artefactId: number; previousRequestId: string | null; requestId: string; at: Date; staleBefore: Date; maxAttempts: number }): Promise<boolean>;
    /** Stores the granted terms only on the first on-fetch (FetchedAt null) while the artefact is GRANTED; false otherwise. */
    saveFetchedDetail(artefactId: number, detail: FetchedDetail): Promise<boolean>;
    /**
     * Ends an artefact that is still GRANTED, in one short transaction (tried again on a timeout or
     * deadlock): sets [status], nulls PrivateKey on its data requests and drops its sealed care
     * contexts, so its records can no longer be read or added to. True when this call ended it; false
     * when it had already ended. What was stored is deleted afterwards (purgeRecords).
     */
    endArtefact(artefactId: number, status: "REVOKED" | "EXPIRED" | "DENIED", at: Date): Promise<boolean>;
    /**
     * Deletes an ended artefact's AbdmHiuRecords rows, a row at a time, and sets RecordsPurgedAt once
     * none is left (also when there were none). Returns how many it deleted; throws (a RecordPurgeError
     * with the count so far) when it could not finish: the maintenance sweep deletes the rest.
     */
    purgeRecords(artefactId: number, at: Date): Promise<number>;
    /** Audit rows of this hospital tied to the request by consent request id, our REQUEST-IDs or its artefacts. */
    listEvents(input: { hospitalId: number; consentRequestId: string | null; requestIds: string[]; artefactIds: string[] }): Promise<{ at: Date; event: string; outcome: string }[]>;
}

/** The deployment-wide settings the consent side needs; read from abdmConfig unless a test injects them. */
export interface HiuSettings {
    /** The deployment can act as an HIU (ABDM client, records key); which HIU id is per hospital. */
    configured: boolean;
    abhaAddressSuffix: string;
}

export type HiuDirectory = Pick<AbdmFacilityDirectory, "hiu" | "hiuById">;

export interface HiuConsentDeps {
    gateway?: Pick<AbdmGatewayService, "call">;
    /** Each hospital's HIU (AbdmFacilities); the deployment's directory unless a test injects one. */
    directory?: HiuDirectory;
    /** The records push base (ABDM_DATA_PUSH_BASE_URL, else the bridge URL), checked before a request is raised. */
    pushBaseUrl?: () => Promise<string>;
    audit?: HiuAudit;
    clock?: () => number;
    requester?: HealthInformationRequester | null;
    settings?: () => HiuSettings;
    atRestKeys?: () => AtRestKeys | null;
    /** REQUEST-ID generator. */
    newId?: () => string;
}

// ---- Rules ----

/** consent.hiu.id / hip.id pattern from the init schema. */
const SERVICE_ID_PATTERN = /^[A-Za-z0-9]+[A-Za-z0-9_-]*[A-Za-z0-9]$/;
/** consent.hiu.name pattern; a name that does not fit is left out (it is optional). */
const SERVICE_NAME_PATTERN = /^[a-zA-Z]+[A-Za-z0-9_\-@,().\s\xa0:/]+$/;
/** requester.identifier.* pattern. */
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9_\-@,. ":/]{0,255}$/;
/** ABDM's ids (consentRequestId, artefact id): UUIDs in practice; anything in the spec's character set up to 64. */
const ABDM_ID_PATTERN = /^[a-zA-Z0-9_\-@,.:]{1,64}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who asks, as the patient's app shows it (requester.identifier). The spec leaves type and system
 * open; we identify the requesting facility by its HIU id, an HFR facility id (plan D1).
 */
export const REQUESTER_IDENTIFIER_TYPE = "HFR";
export const REQUESTER_IDENTIFIER_SYSTEM = "https://facility.abdm.gov.in";

/** The clinic's calendar days are Indian Standard Time: the staff form's dates are IST days. */
const CLINIC_UTC_OFFSET_MS = 330 * 60_000;
/** A SENDING request older than this (its on-init never came) no longer blocks a new one. */
const STALE_SENDING_MS = 15 * 60_000;
/** A granted artefact whose details have not come this long after its last fetch is fetched again by the sweep. */
const FETCH_RETRY_AFTER_MS = 5 * 60_000;
/** consent/fetch calls per artefact, the first included; after these the sweep stops asking. */
const MAX_FETCH_ATTEMPTS = 4;
/** Artefacts the sweep fetches again per run; the rest wait for the next run. */
const FETCH_RETRY_BATCH = 20;
/**
 * dateRange.to is kept this far behind our clock: ABDM refuses a date "in the future" by its own
 * clock ("Date must be a present/before date"), and the two clocks can differ by a few seconds.
 */
const DATE_TO_MARGIN_MS = 5_000;

const dayStart = (date: string): Date => new Date(Date.parse(`${date}T00:00:00.000Z`) - CLINIC_UTC_OFFSET_MS);
const dayEnd = (date: string): Date => new Date(Date.parse(`${date}T23:59:59.999Z`) - CLINIC_UTC_OFFSET_MS);
/** The clinic calendar day (IST) an instant falls on, YYYY-MM-DD. */
export const clinicDate = (date: Date): string => new Date(date.getTime() + CLINIC_UTC_OFFSET_MS).toISOString().slice(0, 10);

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const iso = (date: Date | null | undefined): string | null => (date ? new Date(date).toISOString() : null);
const isoOr = (date: Date | null | undefined): string => iso(date) ?? "";

/** ABDM's ids as stored and logged: only the spec's character set, never free text. */
const abdmId = (value: unknown): string | null => {
    const id = text(value);
    return ABDM_ID_PATTERN.test(id) ? id : null;
};

const isFinalForInit = (status: ConsentStatus): boolean => status !== "SENDING" && status !== "FAILED";

/**
 * The requested permission.dateRange for whole clinic days: from the start of [dateFrom] to the end
 * of [dateTo] (IST), the end kept just behind [now] when [dateTo] is today.
 */
export const requestedDateRange = (dateFrom: string, dateTo: string, now: number): { from: Date; to: Date } => {
    const from = dayStart(dateFrom);
    const end = Math.min(dayEnd(dateTo).getTime(), now - DATE_TO_MARGIN_MS);
    return { from, to: new Date(Math.max(end, from.getTime())) };
};

/** The consent/request/init body, to the spec (hiecm-m3.yaml m3_post_consent_v3_request_init). */
export const buildInitBody = (input: {
    purposeCode: string;
    abhaAddress: string;
    hiuId: string;
    hiuName: string;
    requesterName: string;
    hiTypes: string[];
    accessMode: string;
    from: Date;
    to: Date;
    dataEraseAt: Date;
}): Record<string, unknown> => ({
    consent: {
        purpose: { text: purposeText(input.purposeCode), code: input.purposeCode, refUri: HIU_PURPOSE_REF_URI },
        patient: { id: input.abhaAddress },
        hiu: SERVICE_NAME_PATTERN.test(input.hiuName) ? { id: input.hiuId, name: input.hiuName } : { id: input.hiuId },
        requester: {
            name: input.requesterName,
            identifier: { value: input.hiuId, type: REQUESTER_IDENTIFIER_TYPE, system: REQUESTER_IDENTIFIER_SYSTEM },
        },
        hiTypes: input.hiTypes,
        permission: {
            accessMode: input.accessMode,
            dateRange: { from: abdmDateTime(input.from), to: abdmDateTime(input.to) },
            dataEraseAt: abdmDateTime(input.dataEraseAt),
            frequency: { ...HIU_DEFAULT_FREQUENCY },
        },
    },
});

/**
 * Where an artefact stands for staff. Not GRANTED is BLOCKED (revoked, lapsed or denied: its records
 * are gone or never came). Then: records deleted, details not fetched yet, and the latest transfer.
 */
export const artefactStage = (artefact: Pick<ArtefactWithTransfer, "status" | "recordsPurgedAt" | "fetchedAt" | "dataEraseAt" | "transfer">, now: number): ArtefactStage => {
    if (artefact.status !== "GRANTED") return "BLOCKED";
    if (artefact.recordsPurgedAt || (artefact.dataEraseAt && new Date(artefact.dataEraseAt).getTime() <= now)) return "RECORDS_DELETED";
    if (!artefact.fetchedAt) return "FETCHING_DETAILS";
    const transfer = artefact.transfer;
    if (!transfer) return "REQUESTING_RECORDS";
    switch (transfer.sessionStatus) {
        case "RECEIVING":
            return "RECEIVING";
        case "RECEIVED":
            return "RECEIVED";
        case "FAILED":
            return "TRANSFER_FAILED";
        default:
            // REQUESTED: on-request has answered once ABDM's transaction id is stored.
            return transfer.transactionId ? "WAITING_FOR_PROVIDER" : "REQUESTING_RECORDS";
    }
};

/**
 * A request's status from its artefacts: all live is GRANTED; some live is PARTLY_REVOKED (some
 * revoked or lapsed); none live is REVOKED when any was revoked, else EXPIRED, else DENIED. Null with
 * no artefacts (the status stays as ABDM last said).
 */
export const requestStatusFrom = (artefacts: Pick<ArtefactRow, "status">[]): ConsentStatus | null => {
    if (artefacts.length === 0) return null;
    const live = artefacts.filter((artefact) => artefact.status === "GRANTED").length;
    if (live === artefacts.length) return "GRANTED";
    if (live > 0) return "PARTLY_REVOKED";
    if (artefacts.some((artefact) => artefact.status === "REVOKED")) return "REVOKED";
    if (artefacts.some((artefact) => artefact.status === "EXPIRED")) return "EXPIRED";
    return "DENIED";
};

const maskAbhaNumber = (abhaNumber: string | null): string | null => {
    const digits = (abhaNumber ?? "").replace(/\D/g, "");
    return digits.length >= 4 ? `xx-xxxx-xxxx-${digits.slice(-4)}` : null;
};

const defaultSettings = (): HiuSettings => ({
    // The client credentials too: without them the init could not be sent, so nothing is stored.
    configured: abdmConfig.hiuConfigured && abdmConfig.isConfigured,
    abhaAddressSuffix: abdmConfig.abhaAddressSuffix,
});

/** The deployment's facility directory, loaded on first use so this module loads without a database. */
const facilityDirectory = async (): Promise<HiuDirectory> => (await import("../abdm-facilities.service.js")).abdmFacilities;
const defaultDirectory: HiuDirectory = {
    hiu: async (hospitalId) => (await facilityDirectory()).hiu(hospitalId),
    hiuById: async (hiuId) => (await facilityDirectory()).hiuById(hiuId),
};

/**
 * A consent/request/init that got no answer (a timeout, or the connection dropped): ABDM may still
 * have taken it, so its row [id] stays SENDING for on-init or the stale-SENDING sweep to settle. The
 * staff API answers it with the same status as the underlying ABDM failure, adding
 * mayHaveBeenSent, the row's id and the init REQUEST-ID.
 */
export class ConsentInitUnansweredError extends AbdmApiError {
    readonly id: number;
    readonly initRequestId: string;

    constructor(cause: AbdmApiError, id: number, initRequestId: string) {
        super({
            status: cause.status,
            kind: cause.kind,
            message: cause.message,
            operation: cause.operation,
            code: cause.code,
            field: cause.field,
            requestId: cause.requestId ?? initRequestId,
        });
        this.name = "ConsentInitUnansweredError";
        this.id = id;
        this.initRequestId = initRequestId;
    }
}

const invalid = (field: string, message: string): HiuError => new HiuError("validation", message, { details: { field } });

export class HiuConsentService {
    private readonly store: HiuConsentStore;
    private readonly gateway: Pick<AbdmGatewayService, "call">;
    private readonly audit: HiuAudit;
    private readonly clock: () => number;
    private readonly settings: () => HiuSettings;
    private readonly directory: HiuDirectory;
    private readonly pushBaseUrl: () => Promise<string>;
    private readonly atRestKeys: () => AtRestKeys | null;
    private readonly newId: () => string;
    private requester: HealthInformationRequester | null;

    constructor(store: HiuConsentStore, deps: HiuConsentDeps = {}) {
        this.store = store;
        this.gateway = deps.gateway ?? abdmGatewayService;
        this.audit = deps.audit ?? hiuAuditRepository;
        this.clock = deps.clock ?? Date.now;
        this.settings = deps.settings ?? defaultSettings;
        this.directory = deps.directory ?? defaultDirectory;
        this.pushBaseUrl = deps.pushBaseUrl ?? deploymentPushBaseUrl;
        this.atRestKeys = deps.atRestKeys ?? atRestKeysFromConfig;
        this.newId = deps.newId ?? randomUUID;
        this.requester = deps.requester ?? null;
    }

    /** The data-flow service, set once both services exist (they need each other). */
    setRequester(requester: HealthInformationRequester): void {
        this.requester = requester;
    }

    /**
     * The HIU [hospitalId]'s staff request records as. Refused (503 not-configured) unless the server
     * can act as an HIU and the hospital has an HIU id of its own: never another hospital's id.
     */
    private async hiuFor(hospitalId: number): Promise<Hiu> {
        if (!this.settings().configured) throw hiuNotConfiguredError();
        const base = await this.pushBaseUrl().catch(() => "");
        if (!isDataPushBase(base)) throw hiuNotConfiguredError();
        const hiu = await this.directory.hiu(hospitalId);
        if (!hiu || hiu.hospitalId !== hospitalId || !SERVICE_ID_PATTERN.test(hiu.id)) throw hiuFacilityNotConfiguredError();
        // ABDM's answers come back by that id: it must lead to this hospital alone, as the callbacks
        // resolve it. An id two hospitals answer to (rows written around save()'s check) is never used.
        if ((await this.directory.hiuById(hiu.id))?.hospitalId !== hospitalId) throw hiuFacilityNotConfiguredError();
        return hiu;
    }

    /** What the staff form offers, and whether this hospital can raise requests now (and why not). */
    async options(ctx: Pick<StaffContext, "hospitalId">): Promise<HiuOptions> {
        let reason: string | null = null;
        try {
            await this.hiuFor(ctx.hospitalId);
        } catch (error) {
            if (!(error instanceof HiuError)) throw error;
            reason = error.message;
        }
        return {
            configured: reason === null,
            ...(reason === null ? {} : { reason }),
            purposes: HIU_PURPOSES.map(({ code, text }) => ({ code, text })),
            hiTypes: HIU_HI_TYPES.map(({ code, label }) => ({ code, label })),
            accessModes: [...HIU_ACCESS_MODES],
            defaults: { purpose: "CAREMGT", accessMode: "VIEW" },
        };
    }

    /** The patient's stored ABHA address, resolved here so the browser never supplies it. */
    async patientAbha(ctx: StaffContext, patientUserId: string): Promise<PatientAbhaView> {
        const patient = GUID.test(text(patientUserId)) ? await this.store.findPatient(text(patientUserId), ctx.hospitalId) : null;
        if (!patient) throw new HiuError("not-found", "That patient isn't registered at this hospital.");
        return {
            userId: patient.userId,
            name: patient.name,
            abhaAddress: patient.abhaAddress || null,
            abhaNumberMasked: maskAbhaNumber(patient.abhaNumber),
        };
    }

    /**
     * Raises a consent request. Everything is checked before anything is stored or sent; the row is
     * stored as SENDING with its REQUEST-ID before the call, because on-init can arrive before the 202.
     */
    async create(ctx: StaffContext, input: NewConsentRequestInput): Promise<ConsentRequestSummary> {
        const settings = this.settings();
        const hiu = await this.hiuFor(ctx.hospitalId);

        const now = this.clock();
        const patientUserId = text(input?.patientUserId);
        if (!GUID.test(patientUserId)) throw invalid("patientUserId", "Choose a patient.");
        if (!isPurposeCode(input?.purposeCode)) throw invalid("purposeCode", "Choose a purpose from ABDM's list.");
        const hiTypes = parseHiTypes(input?.hiTypes);
        if (!hiTypes) throw invalid("hiTypes", "Choose at least one record type, each once, from ABDM's list.");
        if (!isDateOnly(input?.dateFrom)) throw invalid("dateFrom", "Records from must be a date (YYYY-MM-DD).");
        if (!isDateOnly(input?.dateTo)) throw invalid("dateTo", "Records to must be a date (YYYY-MM-DD).");
        if (input.dateFrom > input.dateTo) throw invalid("dateFrom", "Records from must be on or before Records to.");
        if (dayStart(input.dateFrom).getTime() > now) throw invalid("dateFrom", "Records from can't be in the future.");
        if (dayStart(input.dateTo).getTime() > now) throw invalid("dateTo", "Records to can't be in the future.");
        const dataEraseAt = parseDateTime(input?.dataEraseAt);
        if (!dataEraseAt) throw invalid("dataEraseAt", "Delete records by must be a date and time.");
        if (dataEraseAt.getTime() <= now) throw invalid("dataEraseAt", "Delete records by must be in the future.");
        if (!isAccessMode(input?.accessMode)) throw invalid("accessMode", "Choose an access mode from ABDM's list.");

        const patient = await this.store.findPatient(patientUserId, ctx.hospitalId);
        if (!patient) throw new HiuError("not-found", "That patient isn't registered at this hospital.");
        const abhaAddress = text(patient.abhaAddress);
        if (!abhaAddress) throw invalid("patientUserId", "This patient has no ABHA address. Link an ABHA first.");
        if (!isAbhaAddress(abhaAddress, settings.abhaAddressSuffix)) {
            throw invalid("patientUserId", "This patient's ABHA address isn't one ABDM accepts here. Verify the ABHA again.");
        }

        const range = requestedDateRange(input.dateFrom, input.dateTo, now);
        const staffName = await this.store.staffName(ctx.staffUserId).catch(() => null);
        const initRequestId = this.newId();
        const at = new Date(now);
        const need = { hospitalId: ctx.hospitalId, patientUserId, purposeCode: input.purposeCode };
        // The check and the insert hold one lock, so a double submit cannot send the patient two requests.
        const id = await this.store.withOpenRequestLock(need, async () => {
            // "Do not raise a second request for the same need while the first is open."
            const open = await this.store.findOpenRequests(need);
            const clash = open.find((row) =>
                (row.status === "REQUESTED" || (row.status === "SENDING" && now - new Date(row.createdAt).getTime() < STALE_SENDING_MS))
                && row.hiTypes.some((type) => hiTypes.includes(type as never)));
            if (clash) {
                throw new HiuError("conflict", "An open request for this patient, purpose and record type is already waiting for the patient.", {
                    details: { id: clash.id },
                });
            }
            return this.store.createRequest({
                initRequestId,
                hospitalId: ctx.hospitalId,
                hiuId: hiu.id,
                organizationId: ctx.organizationId,
                staffUserId: ctx.staffUserId,
                staffName,
                patientUserId,
                abhaAddress,
                purposeCode: input.purposeCode,
                hiTypes,
                dateFrom: range.from,
                dateTo: range.to,
                dataEraseAt,
                accessMode: input.accessMode,
                status: "SENDING",
                statusAt: at,
            });
        });

        const body = buildInitBody({
            purposeCode: input.purposeCode,
            abhaAddress,
            hiuId: hiu.id,
            hiuName: hiu.name,
            requesterName: staffName || hiu.name || hiu.id,
            hiTypes,
            accessMode: input.accessMode,
            from: range.from,
            to: range.to,
            dataEraseAt,
        });

        try {
            // No X-HIU-ID here: init carries the HIU id in consent.hiu.id.
            await this.gateway.call({
                operation: "consent/v3/request/init",
                method: "POST",
                host: "gateway",
                path: "/api/hiecm/consent/v3/request/init",
                body,
                requestId: initRequestId,
            });
        } catch (error: any) {
            const abdm = error instanceof AbdmApiError ? error : null;
            const code = abdm?.code ?? null;
            const message = String(abdm?.message || "The request could not be sent to ABDM.").slice(0, 500);
            // No answer (a timeout) may still mean ABDM took the request, and its on-init may even have
            // come first: the row stays SENDING for on-init, or the stale-SENDING sweep, to settle. A
            // definite refusal fails it, but never a row that on-init has already moved on.
            const unknown = isOutcomeUnknown(error);
            const changes: ConsentRequestChanges = unknown
                ? { abdmErrorCode: code, abdmError: message }
                : { status: "FAILED", statusAt: new Date(this.clock()), abdmErrorCode: code, abdmError: message };
            await this.store.updateSendingRequest(id, changes)
                .catch(() => console.error(`[ABDM HIU] could not record the init failure of request ${id}`));
            await this.audit.record({
                hospitalId: ctx.hospitalId,
                staffUserId: ctx.staffUserId,
                event: HIU_AUDIT_EVENTS.CONSENT_INIT,
                requestId: initRequestId,
                outcome: abdm?.kind === "rejected" ? HIU_AUDIT_OUTCOMES.REJECTED : HIU_AUDIT_OUTCOMES.FAILED,
                detail: code ?? abdm?.kind ?? "error",
            });
            console.warn(`[ABDM HIU] consent init REQUEST-ID=${initRequestId} request=${id} failed: ${code ?? abdm?.kind ?? error?.name ?? "error"}`);
            // The row is kept (SENDING): say so, with its id, so staff reload the list rather than raise it again.
            if (unknown && abdm) throw new ConsentInitUnansweredError(abdm, id, initRequestId);
            throw error;
        }

        await this.audit.record({
            hospitalId: ctx.hospitalId,
            staffUserId: ctx.staffUserId,
            event: HIU_AUDIT_EVENTS.CONSENT_INIT,
            requestId: initRequestId,
            outcome: HIU_AUDIT_OUTCOMES.OK,
            detail: `${input.purposeCode} ${hiTypes.length} types`,
        });
        console.log(`[ABDM HIU] consent init REQUEST-ID=${initRequestId} request=${id} sent`);

        // on-init may already have answered.
        const row = await this.store.findRequest(ctx.hospitalId, id);
        if (!row) throw new HiuError("not-found", "The request could not be read back.");
        return this.summary({ ...row, patientName: row.patientName ?? patient.name, patientAbhaNumber: row.patientAbhaNumber ?? patient.abhaNumber });
    }

    async list(ctx: StaffContext, query: { page: number; pageSize: number; status?: string }): Promise<{ items: ConsentRequestSummary[]; total: number }> {
        const page = Number.isInteger(query?.page) && query.page > 0 ? query.page : 1;
        const pageSize = Number.isInteger(query?.pageSize) && query.pageSize > 0 ? Math.min(query.pageSize, 100) : 20;
        const status = text(query?.status) || undefined;
        if (status && !["SENDING", "REQUESTED", "GRANTED", "PARTLY_REVOKED", "DENIED", "EXPIRED", "REVOKED", "FAILED"].includes(status)) {
            throw invalid("status", "Unknown status filter.");
        }
        const { rows, total } = await this.store.listRequests({ hospitalId: ctx.hospitalId, page, pageSize, status });
        return { items: rows.map((row) => this.summary(row)), total };
    }

    async detail(ctx: StaffContext, id: number): Promise<ConsentRequestDetail> {
        const row = Number.isInteger(id) && id > 0 ? await this.store.findRequest(ctx.hospitalId, id) : null;
        if (!row) throw new HiuError("not-found", "No such record request at this hospital.");
        const now = this.clock();
        const artefacts = await this.store.listArtefacts(row.id);
        const events = await this.store.listEvents({
            hospitalId: ctx.hospitalId,
            consentRequestId: row.consentRequestId,
            requestIds: [row.initRequestId, row.statusRequestId].filter((value): value is string => Boolean(value)),
            artefactIds: artefacts.map((artefact) => artefact.consentArtefactId),
        });
        return {
            ...this.summary({ ...row, artefactCount: artefacts.length }),
            artefacts: artefacts.map((artefact) => this.artefactView(artefact, now)),
            events: events.map((event) => ({ at: isoOr(event.at), event: event.event, outcome: event.outcome })),
        };
    }

    /** Asks ABDM for the request's status; the answer arrives on on-status. */
    async refreshStatus(ctx: StaffContext, id: number): Promise<ConsentRequestSummary> {
        await this.hiuFor(ctx.hospitalId);
        const row = Number.isInteger(id) && id > 0 ? await this.store.findRequest(ctx.hospitalId, id) : null;
        if (!row) throw new HiuError("not-found", "No such record request at this hospital.");
        if (!row.consentRequestId) {
            throw new HiuError("conflict", "ABDM hasn't given this request an id yet, so its status can't be asked for.");
        }
        // Asked as the HIU the request was raised as, which may differ from the hospital's id today.
        if (!row.hiuId) throw new HiuError("conflict", "This request has no ABDM HIU id on record, so its status can't be asked for.");

        const statusRequestId = this.newId();
        await this.store.updateRequest(row.id, { statusRequestId });
        try {
            await this.gateway.call({
                operation: "consent/v3/request/status",
                method: "POST",
                host: "gateway",
                path: "/api/hiecm/consent/v3/request/status",
                headers: { "X-HIU-ID": row.hiuId },
                body: { consentRequestId: row.consentRequestId },
                requestId: statusRequestId,
            });
        } catch (error: any) {
            await this.audit.record({
                hospitalId: row.hospitalId,
                staffUserId: ctx.staffUserId,
                event: HIU_AUDIT_EVENTS.STATUS_REQUEST,
                consentRequestId: row.consentRequestId,
                requestId: statusRequestId,
                outcome: error instanceof AbdmApiError && error.kind === "rejected" ? HIU_AUDIT_OUTCOMES.REJECTED : HIU_AUDIT_OUTCOMES.FAILED,
                detail: error instanceof AbdmApiError ? (error.code ?? error.kind) : "error",
            });
            throw error;
        }
        await this.audit.record({
            hospitalId: row.hospitalId,
            staffUserId: ctx.staffUserId,
            event: HIU_AUDIT_EVENTS.STATUS_REQUEST,
            consentRequestId: row.consentRequestId,
            requestId: statusRequestId,
            outcome: HIU_AUDIT_OUTCOMES.OK,
        });
        console.log(`[ABDM HIU] status REQUEST-ID=${statusRequestId} consentRequestId=${row.consentRequestId} sent`);
        return this.summary((await this.store.findRequest(ctx.hospitalId, row.id)) ?? { ...row, statusRequestId });
    }

    // ---- Sweep steps (HiuMaintenanceService runs these once a minute; they never throw past it) ----

    /**
     * Fails each request still SENDING without an ABDM id after STALE_SENDING_MS: its on-init never
     * came (lost, or the init never reached ABDM). Staff can then raise it again on purpose; an on-init
     * arriving later still recovers it, since FAILED is not final for on-init. Returns how many.
     */
    async failStaleSending(now: number = this.clock()): Promise<number> {
        const failed = await this.store.failStaleSending({
            createdBefore: new Date(now - STALE_SENDING_MS),
            at: new Date(now),
            message: "ABDM did not confirm this request. Raise it again if it is still needed.",
        });
        for (const row of failed) {
            await this.audit.record({
                hospitalId: row.hospitalId,
                event: HIU_AUDIT_EVENTS.CONSENT_INIT,
                requestId: row.initRequestId,
                outcome: HIU_AUDIT_OUTCOMES.FAILED,
                detail: "no on-init",
            });
            console.warn(`[ABDM HIU] consent init REQUEST-ID=${row.initRequestId} request=${row.id} had no on-init; FAILED`);
        }
        return failed.length;
    }

    /**
     * Fetches again each granted artefact whose details never came: its fetch was refused, or no
     * on-fetch followed it (the notify is already acknowledged, so ABDM will not repeat it). Each
     * gets a fresh REQUEST-ID, swapped in atomically, so a late answer to the old one is dropped;
     * at most MAX_FETCH_ATTEMPTS fetches per artefact. Returns how many were sent.
     */
    async retryFetches(now: number = this.clock()): Promise<number> {
        if (!this.settings().configured) return 0;
        const staleBefore = new Date(now - FETCH_RETRY_AFTER_MS);
        const due = await this.store.listFetchRetries({ staleBefore, maxAttempts: MAX_FETCH_ATTEMPTS, limit: FETCH_RETRY_BATCH });
        let sent = 0;
        for (const artefact of due) {
            const row = await this.store.findRequestById(artefact.consentRequestFk);
            if (!row?.hiuId) continue;
            const fetchRequestId = this.newId();
            const claimed = await this.store.reclaimFetch({
                artefactId: artefact.id,
                previousRequestId: artefact.fetchRequestId,
                requestId: fetchRequestId,
                at: new Date(this.clock()),
                staleBefore,
                maxAttempts: MAX_FETCH_ATTEMPTS,
            });
            if (!claimed) continue;
            await this.sendFetch(row, artefact, fetchRequestId);
            sent += 1;
        }
        return sent;
    }

    // ---- Callbacks: answered 200 by the controller before these run; they never throw ----

    /** on-init: ABDM's consent request id for our init, or why it refused it. */
    async onInit(body: any, headers: CallbackHeaders): Promise<void> {
        await this.guard("on-init", headers, async () => {
            const requestId = text(body?.response?.requestId);
            const row = requestId ? await this.store.findRequestByInitRequestId(requestId) : null;
            if (!row) return this.dropUnknown(HIU_AUDIT_EVENTS.ON_INIT, requestId, headers);
            if (await this.dropOtherHiu(row, HIU_AUDIT_EVENTS.ON_INIT, requestId, headers)) return;
            const at = new Date(this.clock());
            const consentRequestId = abdmId(body?.consentRequest?.id);
            const error = body?.error && typeof body.error === "object" ? body.error : null;

            if (consentRequestId && !error) {
                if (row.consentRequestId) {
                    console.log(`[ABDM HIU] on-init REQUEST-ID=${requestId} repeated; request=${row.id} already has its id`);
                    return;
                }
                await this.store.updateRequest(row.id, {
                    consentRequestId,
                    // A request already moved on (a notify matched it) keeps its newer status.
                    ...(isFinalForInit(row.status) ? {} : { status: "REQUESTED" as const, statusAt: at, abdmErrorCode: null, abdmError: null }),
                });
                await this.record(row, HIU_AUDIT_EVENTS.ON_INIT, HIU_AUDIT_OUTCOMES.OK, { consentRequestId, requestId });
                console.log(`[ABDM HIU] on-init REQUEST-ID=${requestId} request=${row.id} consentRequestId=${consentRequestId} REQUESTED`);
                return;
            }

            const code = normalizeAbdmCode(error?.code);
            const message = String(text(error?.message) || "ABDM refused the request without a reason.").slice(0, 500);
            if (row.consentRequestId || isFinalForInit(row.status)) {
                console.warn(`[ABDM HIU] on-init REQUEST-ID=${requestId} error ${code ?? "-"} ignored: request=${row.id} is ${row.status}`);
                return;
            }
            await this.store.updateRequest(row.id, { status: "FAILED", statusAt: at, abdmErrorCode: code, abdmError: message });
            await this.record(row, HIU_AUDIT_EVENTS.ON_INIT, HIU_AUDIT_OUTCOMES.REJECTED, { requestId, detail: code });
            console.warn(`[ABDM HIU] on-init REQUEST-ID=${requestId} request=${row.id} FAILED ${code ?? "-"}`);
        });
    }

    /** on-status: answers our consent/request/status. GRANTED is accepted though the spec's enum omits it. */
    async onStatus(body: any, headers: CallbackHeaders): Promise<void> {
        await this.guard("on-status", headers, async () => {
            const requestId = text(body?.response?.requestId);
            const row = requestId ? await this.store.findRequestByStatusRequestId(requestId) : null;
            if (!row) return this.dropUnknown(HIU_AUDIT_EVENTS.ON_STATUS, requestId, headers);
            if (await this.dropOtherHiu(row, HIU_AUDIT_EVENTS.ON_STATUS, requestId, headers)) return;
            const error = body?.error && typeof body.error === "object" ? body.error : null;
            const consentRequestId = abdmId(body?.consentRequest?.id);
            const status = text(body?.consentRequest?.status);
            if (error || !isNotifyConsentStatus(status)) {
                const code = normalizeAbdmCode(error?.code);
                await this.record(row, HIU_AUDIT_EVENTS.ON_STATUS, HIU_AUDIT_OUTCOMES.REJECTED, { requestId, detail: code ?? "no status" });
                console.warn(`[ABDM HIU] on-status REQUEST-ID=${requestId} request=${row.id} refused ${code ?? "-"}`);
                return;
            }
            if (consentRequestId && row.consentRequestId && consentRequestId !== row.consentRequestId) {
                console.warn(`[ABDM HIU] on-status REQUEST-ID=${requestId} names another consent request; dropped`);
                return;
            }
            await this.record(row, HIU_AUDIT_EVENTS.ON_STATUS, status, { requestId });
            const ended = await this.applyStatus(row, status, null);
            console.log(`[ABDM HIU] on-status REQUEST-ID=${requestId} request=${row.id} ${status}`);
            await this.purgeEnded(row, ended, status);
        });
    }

    /**
     * notify: the patient's decision. Every artefact id is stored, the notification is acknowledged on
     * hiu/on-notify with one entry per artefact, and each granted artefact not yet fetched is fetched.
     * DENIED and EXPIRED end the request (no fetch, no retry); REVOKED ends the named artefacts and
     * deletes what was received under them. A repeat changes nothing and fetches nothing again.
     *
     * A notification for a consent request (and artefacts) we do not hold is logged and dropped, not
     * acknowledged: shared sandbox bridges deliver other HIUs' notifications, and acknowledging those
     * would claim them (hiecm.concept.callback-authenticity: "log and drop: do not store, answer or retry").
     */
    async notify(body: any, headers: CallbackHeaders): Promise<void> {
        await this.guard("notify", headers, async () => {
            const notification = body?.notification ?? {};
            const status = text(notification.status);
            const consentRequestId = abdmId(notification.consentRequestId);
            const artefactIds = [...new Set(
                (Array.isArray(notification.consentArtefacts) ? notification.consentArtefacts : [])
                    .map((artefact: any) => abdmId(artefact?.id))
                    .filter((id: string | null): id is string => Boolean(id)),
            )] as string[];
            const notifyRequestId = text(headers?.requestId) || null;

            if (!isNotifyConsentStatus(status)) {
                console.warn(`[ABDM HIU] notify REQUEST-ID=${notifyRequestId ?? "-"} with an unknown status; dropped`);
                return;
            }

            // The requests this notification concerns: by consentRequestId, else (a revocation names
            // only artefacts) through the artefacts we hold.
            let found: ConsentRequestRow[] = [];
            const byId = consentRequestId ? await this.store.findRequestByConsentRequestId(consentRequestId) : null;
            if (byId) {
                found = [byId];
            } else if (artefactIds.length > 0 && (status === "REVOKED" || status === "EXPIRED")) {
                const known = await this.store.findArtefactsByConsentArtefactIds(artefactIds);
                for (const fk of new Set(known.map((artefact) => artefact.consentRequestFk))) {
                    const row = await this.store.findRequestById(fk);
                    if (row) found.push(row);
                }
            }
            // Only requests raised as the HIU this notification is addressed to: another tenant's
            // facility can never change (or acknowledge) a request it did not raise.
            const rows: ConsentRequestRow[] = [];
            for (const row of found) {
                if (!(await this.dropOtherHiu(row, notifyAuditEvent(status), notifyRequestId, headers))) rows.push(row);
            }
            if (found.length > 0 && rows.length === 0) return;
            if (rows.length === 0) {
                await this.audit.record({
                    hospitalId: null,
                    event: notifyAuditEvent(status),
                    consentRequestId,
                    requestId: notifyRequestId,
                    outcome: HIU_AUDIT_OUTCOMES.IGNORED,
                    detail: "unknown consent request",
                });
                console.warn(`[ABDM HIU] notify REQUEST-ID=${notifyRequestId ?? "-"} ${status} for an unknown consent request; dropped`);
                return;
            }

            const ended: { row: ConsentRequestRow; artefacts: ArtefactRow[] }[] = [];
            for (const row of rows) {
                await this.record(row, notifyAuditEvent(status), HIU_AUDIT_OUTCOMES.OK, {
                    requestId: notifyRequestId,
                    detail: `${artefactIds.length} artefacts`,
                });
                if (status === "GRANTED") {
                    await this.store.addArtefacts({ consentRequestFk: row.id, hospitalId: row.hospitalId, consentArtefactIds: artefactIds, at: new Date(this.clock()) });
                } else if ((status === "REVOKED" || status === "EXPIRED") && row === byId && artefactIds.length > 0) {
                    // Every artefact id is kept, even one whose GRANTED notify never got stored: it is
                    // stored already ended, so it is never fetched and nothing is received under it.
                    await this.store.addArtefacts({ consentRequestFk: row.id, hospitalId: row.hospitalId, consentArtefactIds: artefactIds, at: new Date(this.clock()), status });
                }
                ended.push({ row, artefacts: await this.applyStatus(row, status, artefactIds) });
            }
            console.log(`[ABDM HIU] notify REQUEST-ID=${notifyRequestId ?? "-"} ${status} request=${rows.map((row) => row.id).join(",")} artefacts=${artefactIds.length}`);

            await this.acknowledge(rows[0]!, notifyRequestId, artefactIds);

            // The records of what was revoked or lapsed: access already stopped and ABDM has its answer.
            for (const item of ended) await this.purgeEnded(item.row, item.artefacts, status);

            if (status === "GRANTED") {
                for (const row of rows) await this.fetchArtefacts(row);
            }
        });
    }

    /**
     * on-fetch: what the patient granted under one artefact. Stored once (a repeat changes nothing);
     * then, when GRANTED and before its dataEraseAt, the data-flow service is asked for the records.
     */
    async onFetch(body: any, headers: CallbackHeaders): Promise<void> {
        await this.guard("on-fetch", headers, async () => {
            const requestId = text(body?.response?.requestId);
            const artefact = requestId ? await this.store.findArtefactByFetchRequestId(requestId) : null;
            if (!artefact) return this.dropUnknown(HIU_AUDIT_EVENTS.ON_FETCH, requestId, headers);
            const row = await this.store.findRequestById(artefact.consentRequestFk);
            if (!row) return this.dropUnknown(HIU_AUDIT_EVENTS.ON_FETCH, requestId, headers);
            if (await this.dropOtherHiu(row, HIU_AUDIT_EVENTS.ON_FETCH, requestId, headers)) return;
            const now = this.clock();
            const at = new Date(now);
            const consent = body?.consent && typeof body.consent === "object" ? body.consent : null;
            const error = body?.error && typeof body.error === "object" ? body.error : null;

            if (error || !consent) {
                const code = normalizeAbdmCode(error?.code);
                await this.record(row, HIU_AUDIT_EVENTS.ON_FETCH, HIU_AUDIT_OUTCOMES.REJECTED, { artefactId: artefact.consentArtefactId, requestId, detail: code });
                console.warn(`[ABDM HIU] on-fetch REQUEST-ID=${requestId} artefact=${artefact.consentArtefactId} refused ${code ?? "-"}`);
                return;
            }

            const detail = consent.consentDetail && typeof consent.consentDetail === "object" ? consent.consentDetail : null;
            const named = abdmId(detail?.consentId);
            if (named && named !== artefact.consentArtefactId) {
                console.warn(`[ABDM HIU] on-fetch REQUEST-ID=${requestId} names another artefact; dropped`);
                return;
            }

            const status = text(consent.status);
            if (!isArtefactStatus(status)) {
                console.warn(`[ABDM HIU] on-fetch REQUEST-ID=${requestId} with an unknown status; dropped`);
                return;
            }
            await this.record(row, HIU_AUDIT_EVENTS.ON_FETCH, status, { artefactId: artefact.consentArtefactId, requestId });

            if (status !== "GRANTED") {
                const ended = await this.endArtefacts([artefact], status);
                await this.recompute(row);
                console.log(`[ABDM HIU] on-fetch REQUEST-ID=${requestId} artefact=${artefact.consentArtefactId} ${status}`);
                await this.purgeEnded(row, ended, status);
                return;
            }
            if (!detail) {
                console.warn(`[ABDM HIU] on-fetch REQUEST-ID=${requestId} GRANTED without consentDetail; dropped`);
                return;
            }
            // A revocation that overtook this answer wins: nothing is stored or requested for an artefact
            // that is no longer granted (saveFetchedDetail checks again, for one landing in between).
            if (artefact.status !== "GRANTED") {
                console.log(`[ABDM HIU] on-fetch REQUEST-ID=${requestId} artefact=${artefact.consentArtefactId} is ${artefact.status}; nothing stored`);
                return;
            }

            const granted = this.grantedDetail(detail, consent.signature, at);
            const first = await this.store.saveFetchedDetail(artefact.id, granted);
            if (!first) {
                console.log(`[ABDM HIU] on-fetch REQUEST-ID=${requestId} artefact=${artefact.consentArtefactId} repeated or no longer granted; nothing changed`);
                return;
            }
            console.log(`[ABDM HIU] on-fetch REQUEST-ID=${requestId} artefact=${artefact.consentArtefactId} GRANTED, ${granted.hiTypes.length} types`);

            if (!granted.dataEraseAt || granted.dataEraseAt.getTime() <= now) {
                console.log(`[ABDM HIU] artefact=${artefact.consentArtefactId} is past its erase date; no records requested`);
                return;
            }
            if (!this.requester) {
                console.error(`[ABDM HIU] artefact=${artefact.consentArtefactId} granted, but no health-information requester is set`);
                return;
            }
            try {
                await this.requester.requestForArtefact(artefact.id);
            } catch (requestError: any) {
                console.error(`[ABDM HIU] health-information request for artefact=${artefact.consentArtefactId} failed: ${requestError?.code ?? requestError?.kind ?? requestError?.name ?? "error"}`);
            }
        });
    }

    // ---- Internals ----

    /** Runs a callback's work; a failure is logged in one line (no body) and never thrown. */
    private async guard(name: string, headers: CallbackHeaders, work: () => Promise<void>): Promise<void> {
        try {
            await work();
        } catch (error: any) {
            console.error(`[ABDM HIU] ${name} REQUEST-ID=${text(headers?.requestId) || "-"} failed: ${error?.code ?? error?.kind ?? error?.name ?? "error"}`);
        }
    }

    /**
     * True, after auditing it IGNORED, when [row] was raised as another HIU than the callback's
     * X-HIU-ID: one tenant's facility never updates another tenant's request.
     */
    private async dropOtherHiu(row: ConsentRequestRow, event: string, requestId: string | null, headers: CallbackHeaders): Promise<boolean> {
        const hiuId = text(headers?.hiuId);
        if (row.hiuId && hiuId === row.hiuId) return false;
        await this.audit.record({
            hospitalId: row.hospitalId,
            event,
            requestId: requestId || text(headers?.requestId) || null,
            outcome: HIU_AUDIT_OUTCOMES.IGNORED,
            detail: "HIU mismatch",
        });
        console.warn(`[ABDM HIU] ${event} REQUEST-ID=${requestId || text(headers?.requestId) || "-"} names another HIU than request=${row.id}; dropped`);
        return true;
    }

    private async dropUnknown(event: string, requestId: string, headers: CallbackHeaders): Promise<void> {
        await this.audit.record({
            hospitalId: null,
            event,
            requestId: requestId || text(headers?.requestId) || null,
            outcome: HIU_AUDIT_OUTCOMES.IGNORED,
            detail: "unknown requestId",
        });
        console.warn(`[ABDM HIU] ${event} for unknown requestId=${requestId || "-"}; dropped`);
    }

    private async record(
        row: ConsentRequestRow,
        event: string,
        outcome: string,
        extra: { consentRequestId?: string | null; artefactId?: string | null; requestId?: string | null; detail?: string | null } = {},
    ): Promise<void> {
        await this.audit.record({
            hospitalId: row.hospitalId,
            event,
            consentRequestId: extra.consentRequestId ?? row.consentRequestId,
            artefactId: extra.artefactId ?? null,
            requestId: extra.requestId ?? null,
            outcome,
            detail: extra.detail ?? null,
        });
    }

    private async setStatus(row: ConsentRequestRow, status: ConsentStatus): Promise<void> {
        if (row.status === status) return;
        const at = new Date(this.clock());
        await this.store.updateRequest(row.id, { status, statusAt: at });
        row.status = status;
        row.statusAt = at;
    }

    /** The request's status from its artefacts, when it has any. */
    private async recompute(row: ConsentRequestRow): Promise<void> {
        const status = requestStatusFrom(await this.store.listArtefacts(row.id));
        if (status) await this.setStatus(row, status);
    }

    /**
     * Applies a status ABDM reported (notify or on-status). [named] is the artefact list a notify
     * carried; null from on-status. Never moves a request backwards: REQUESTED only from SENDING (or
     * a FAILED init that ABDM accepted after all), DENIED only before any grant.
     */
    private async applyStatus(row: ConsentRequestRow, status: NotifyConsentStatus, named: string[] | null): Promise<ArtefactRow[]> {
        const artefacts = await this.store.listArtefacts(row.id);
        switch (status) {
            case "REQUESTED":
                if (row.status === "SENDING" || (row.status === "FAILED" && row.consentRequestId)) await this.setStatus(row, "REQUESTED");
                return [];
            case "GRANTED":
                if (artefacts.length > 0) await this.recompute(row);
                else if (row.status === "SENDING" || row.status === "REQUESTED" || row.status === "FAILED") await this.setStatus(row, "GRANTED");
                return [];
            case "DENIED":
                if (artefacts.length === 0) await this.setStatus(row, "DENIED");
                else console.warn(`[ABDM HIU] DENIED for request=${row.id}, which already has artefacts; ignored`);
                return [];
            case "EXPIRED":
            case "REVOKED": {
                if (artefacts.length === 0) {
                    await this.setStatus(row, status);
                    return [];
                }
                const targets = named && named.length > 0 ? artefacts.filter((artefact) => named.includes(artefact.consentArtefactId)) : artefacts;
                const ended = await this.endArtefacts(targets, status);
                await this.recompute(row);
                return ended;
            }
        }
    }

    /**
     * Ends each still-granted artefact, each in a short transaction: from then on nothing under it
     * can be read or stored. Returns the ones it ended, whose records purgeEnded then deletes.
     */
    private async endArtefacts(artefacts: ArtefactRow[], status: "REVOKED" | "EXPIRED" | "DENIED"): Promise<ArtefactRow[]> {
        const ended: ArtefactRow[] = [];
        for (const artefact of artefacts) {
            if (artefact.status !== "GRANTED") continue;
            if (!(await this.store.endArtefact(artefact.id, status, new Date(this.clock())))) {
                // Already ended meanwhile (another handler); its records are that handler's, or the sweep's.
                console.log(`[ABDM HIU] artefact=${artefact.consentArtefactId} already ended; ${status} not applied`);
                continue;
            }
            artefact.status = status;
            ended.push(artefact);
            console.log(`[ABDM HIU] artefact=${artefact.consentArtefactId} ${status}`);
        }
        return ended;
    }

    /**
     * Deletes what was received under artefacts just ended. Run after their status is committed, and
     * for a notify after its acknowledgement: on a small database deleting megabytes takes a while
     * and must hold up neither. A failure is audited and left to the maintenance sweep.
     */
    private async purgeEnded(row: ConsentRequestRow, ended: ArtefactRow[], status: string): Promise<void> {
        for (const artefact of ended) {
            try {
                const deleted = await this.store.purgeRecords(artefact.id, new Date(this.clock()));
                await this.record(row, HIU_AUDIT_EVENTS.RECORD_PURGED, HIU_AUDIT_OUTCOMES.OK, {
                    artefactId: artefact.consentArtefactId,
                    detail: `${status}: ${deleted} records`,
                });
                console.log(`[ABDM HIU] artefact=${artefact.consentArtefactId} ${status}; ${deleted} records deleted`);
            } catch (error: any) {
                const deleted = error instanceof RecordPurgeError ? error.deleted : 0;
                const code = errorCodeOf(error instanceof RecordPurgeError ? error.failure : error);
                await this.record(row, HIU_AUDIT_EVENTS.RECORD_PURGED, HIU_AUDIT_OUTCOMES.FAILED, {
                    artefactId: artefact.consentArtefactId,
                    detail: `${status}: ${deleted} records, then ${code}; the sweep deletes the rest`,
                });
                console.error(`[ABDM HIU] artefact=${artefact.consentArtefactId} ${status}; ${deleted} records deleted, then ${code}; the sweep deletes the rest`);
            }
        }
    }

    /** hiu/on-notify: one OK per artefact the notification named (none for DENIED or EXPIRED). */
    private async acknowledge(row: ConsentRequestRow, notifyRequestId: string | null, artefactIds: string[]): Promise<void> {
        if (!notifyRequestId) {
            console.warn(`[ABDM HIU] notify for request=${row.id} carried no REQUEST-ID; cannot acknowledge`);
            return;
        }
        const ackRequestId = this.newId();
        try {
            // X-CM-ID only (added by the gateway service): on-notify takes no X-HIU-ID.
            await this.gateway.call({
                operation: "consent/v3/request/hiu/on-notify",
                method: "POST",
                host: "gateway",
                path: "/api/hiecm/consent/v3/request/hiu/on-notify",
                body: {
                    acknowledgement: artefactIds.map((consentId) => ({ status: "OK", consentId })),
                    response: { requestId: notifyRequestId },
                },
                requestId: ackRequestId,
            });
            await this.record(row, HIU_AUDIT_EVENTS.ON_NOTIFY_SENT, HIU_AUDIT_OUTCOMES.OK, { requestId: ackRequestId, detail: `${artefactIds.length} acknowledged` });
        } catch (error: any) {
            // ABDM's own words beside the code: ABDM-9999 alone does not say why; digits masked.
            const code = error instanceof AbdmApiError ? (error.code ?? error.kind) : "error";
            const message = error instanceof AbdmApiError && error.message ? String(error.message).replace(/\d{6,}/g, "[digits]").slice(0, 200) : "";
            await this.record(row, HIU_AUDIT_EVENTS.ON_NOTIFY_SENT, HIU_AUDIT_OUTCOMES.FAILED, {
                requestId: ackRequestId,
                detail: message ? `${code}: ${message}` : code,
            });
            console.error(`[ABDM HIU] on-notify REQUEST-ID=${ackRequestId} for request=${row.id} failed: ${error?.code ?? error?.kind ?? error?.name ?? "error"}`);
        }
    }

    /** consent/fetch for every granted artefact of the request not yet fetched (claimed first, so a repeat fetches nothing). */
    private async fetchArtefacts(row: ConsentRequestRow): Promise<void> {
        if (!row.hiuId) return;
        for (const artefact of await this.store.listArtefacts(row.id)) {
            if (artefact.status !== "GRANTED" || artefact.fetchRequestId || artefact.fetchedAt) continue;
            const fetchRequestId = this.newId();
            if (!(await this.store.claimFetch(artefact.id, fetchRequestId, new Date(this.clock())))) continue;
            await this.sendFetch(row, artefact, fetchRequestId);
        }
    }

    /** One consent/fetch under a claimed [fetchRequestId]. A failure is recorded, never thrown. */
    private async sendFetch(row: ConsentRequestRow, artefact: ArtefactRow, fetchRequestId: string): Promise<void> {
        try {
            await this.gateway.call({
                operation: "consent/v3/fetch",
                method: "POST",
                host: "gateway",
                path: "/api/hiecm/consent/v3/fetch",
                headers: { "X-HIU-ID": row.hiuId ?? "" },
                body: { consentId: artefact.consentArtefactId },
                requestId: fetchRequestId,
            });
            await this.record(row, HIU_AUDIT_EVENTS.FETCH, HIU_AUDIT_OUTCOMES.OK, { artefactId: artefact.consentArtefactId, requestId: fetchRequestId });
            console.log(`[ABDM HIU] fetch REQUEST-ID=${fetchRequestId} artefact=${artefact.consentArtefactId} sent`);
        } catch (error: any) {
            // No answer may still mean ABDM took the fetch: the claim stays, so its on-fetch still
            // matches. A refusal releases it. Either way the sweep (retryFetches) asks again later if
            // no details arrive; the notify is already acknowledged, so ABDM will not repeat it.
            if (!isOutcomeUnknown(error)) await this.store.releaseFetch(artefact.id, fetchRequestId).catch(() => undefined);
            await this.record(row, HIU_AUDIT_EVENTS.FETCH, HIU_AUDIT_OUTCOMES.FAILED, {
                artefactId: artefact.consentArtefactId,
                requestId: fetchRequestId,
                detail: error instanceof AbdmApiError ? (error.code ?? error.kind) : "error",
            });
            console.error(`[ABDM HIU] fetch REQUEST-ID=${fetchRequestId} artefact=${artefact.consentArtefactId} failed: ${error?.code ?? error?.kind ?? error?.name ?? "error"}`);
        }
    }

    /**
     * The granted terms from consentDetail. dataEraseAt and frequency are read beside permission (where
     * the on-fetch schema puts them) or inside it (where init puts them and permission.required lists them).
     */
    private grantedDetail(detail: any, signature: unknown, at: Date): FetchedDetail {
        const permission = detail.permission && typeof detail.permission === "object" ? detail.permission : {};
        const date = (value: unknown): Date | null => {
            if (typeof value !== "string" || !value.trim()) return null;
            const parsed = new Date(value);
            return Number.isNaN(parsed.getTime()) ? null : parsed;
        };
        const frequency = detail.frequency ?? permission.frequency;
        const careContexts = (Array.isArray(detail.careContexts) ? detail.careContexts : [])
            .filter((context: any) => context && typeof context === "object")
            .map((context: any) => ({ patientReference: text(context.patientReference), careContextReference: text(context.careContextReference) }))
            .filter((context: { careContextReference: string }) => context.careContextReference);
        const keys = this.atRestKeys();
        if (!keys && careContexts.length > 0) console.warn("[ABDM HIU] no records key: granted care contexts not stored");
        const hipId = text(detail.hip?.id);
        return {
            hipId: hipId ? hipId.slice(0, 50) : null,
            hipName: text(detail.hip?.name).slice(0, 200) || null,
            hiTypes: (Array.isArray(detail.hiTypes) ? [...new Set(detail.hiTypes)] : []).filter(isHiType) as string[],
            dateFrom: date(permission.dateRange?.from),
            dateTo: date(permission.dateRange?.to),
            dataEraseAt: date(detail.dataEraseAt) ?? date(permission.dataEraseAt),
            accessMode: isAccessMode(permission.accessMode) ? permission.accessMode : null,
            frequency: frequency && isFrequencyUnit(frequency.unit) && Number.isInteger(Number(frequency.value))
                ? JSON.stringify({ unit: frequency.unit, value: Number(frequency.value), repeats: frequency.repeats ?? null }).slice(0, 200)
                : null,
            careContexts: keys && careContexts.length > 0 ? seal(JSON.stringify(careContexts), keys) : null,
            signature: text(signature) || null,
            fetchedAt: at,
        };
    }

    private summary(row: ConsentRequestRow): ConsentRequestSummary {
        return {
            id: row.id,
            status: row.status,
            statusAt: isoOr(row.statusAt),
            createdAt: isoOr(row.createdAt),
            consentRequestId: row.consentRequestId,
            initRequestId: row.initRequestId,
            patient: {
                userId: row.patientUserId,
                name: row.patientName ?? "",
                abhaAddress: row.abhaAddress,
                abhaNumberMasked: maskAbhaNumber(row.patientAbhaNumber ?? null),
            },
            purposeCode: row.purposeCode,
            hiTypes: row.hiTypes,
            dateFrom: clinicDate(new Date(row.dateFrom)),
            dateTo: clinicDate(new Date(row.dateTo)),
            dataEraseAt: isoOr(row.dataEraseAt),
            accessMode: row.accessMode,
            staffName: row.staffName,
            abdmError: row.abdmError ? { code: row.abdmErrorCode, message: row.abdmError, requestId: row.initRequestId } : null,
            artefactCount: row.artefactCount,
        };
    }

    private artefactView(artefact: ArtefactWithTransfer, now: number): ArtefactView {
        const transfer = artefact.transfer;
        return {
            id: artefact.id,
            consentArtefactId: artefact.consentArtefactId,
            status: artefact.status,
            statusAt: isoOr(artefact.statusAt),
            hip: artefact.hipId ? { id: artefact.hipId, name: artefact.hipName } : null,
            granted: artefact.fetchedAt
                ? {
                    hiTypes: artefact.hiTypes ?? [],
                    dateFrom: isoOr(artefact.dateFrom),
                    dateTo: isoOr(artefact.dateTo),
                    dataEraseAt: iso(artefact.dataEraseAt),
                    accessMode: artefact.accessMode,
                }
                : null,
            stage: artefactStage(artefact, now),
            transfer: transfer
                ? {
                    pagesReceived: transfer.pagesReceived,
                    pageCount: transfer.pageCount,
                    error: transfer.error,
                    requestedAt: iso(transfer.requestedAt),
                    completedAt: iso(transfer.completedAt),
                }
                : null,
            recordCount: artefact.recordCount,
        };
    }
}
