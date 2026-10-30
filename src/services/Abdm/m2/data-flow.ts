import { randomUUID } from "crypto";
import { AbdmApiError, abdmGatewayService, isAbdmSideFailure, type AbdmGatewayService } from "../abdm-gateway.service.js";
import { abdmHealthRecordService, type AbdmHealthRecordService, type HealthRecordBundle } from "../abdm-health-record.service.js";
import { checksum, decodePublicKey, encrypt, generateKeyMaterial, HieCryptoError } from "../hie-crypto.js";
import type { HiType } from "../fhir/fhir-common.js";
import { parseCareContextReference } from "./care-contexts.js";
import type { CareContextRow, Hip, M2Store } from "./m2-store.js";

/**
 * Consent and data flow at the HIP. A consent notification is stored and acknowledged. A health
 * information request is checked against its consent (granted, not expired, inside the consented
 * date range), acknowledged, and then answered by pushing encrypted bundles to the requester's
 * dataPushUrl: only the care contexts and HI types the consent names, only records dated inside
 * both ranges. ABDM is told what was delivered with health-information/notify.
 */

type Gateway = Pick<AbdmGatewayService, "call" | "getAccessToken">;
export type Records = Pick<AbdmHealthRecordService,
    "forAppointment" | "forDischargeSummary" | "forImmunization" | "forVitalsRecord" | "forPrescription" | "forConsultationRecord" | "forClinicalNote" | "forDocument"
    | "forDiagnosticReport" | "forWellnessRecord">;
type Push = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

const PUSH_TIMEOUT_MS = 60_000;
/**
 * AbdmConsents keeps the consented dates as SQL Server datetime, which rounds milliseconds to
 * .000, .003 or .007: a request for exactly the consented range (…48.061Z) reads as 1 ms past
 * the stored end (…48.060Z). Seen 2026-10-26 on PHR app fetches, which ask for exactly that.
 */
const STORED_DATE_SLACK_MS = 4;

/** How long to wait before each further try of on-request: three tries in all. */
const ON_REQUEST_RETRY_MS = [2_000, 5_000];

/**
 * True when ABDM answered with a failure on its own side, which the same call may get past. The
 * sandbox answered an on-request with "Runtime Error" on 2026-10-28, and with no second try the PHR
 * app's fetch of a newly linked visit was lost; the requests before and after it went through.
 */
const failedOnAbdmSide = (error: unknown): boolean =>
    error instanceof AbdmApiError && ((error.kind === "unavailable" && error.status >= 500) || /runtime error/i.test(error.message));

/**
 * How long to wait before each further try of health-information/notify while ABDM fails on its side
 * (isAbdmSideFailure): three tries in all, over about a minute. Unsent, ABDM never learns what was
 * delivered; on 2026-10-29 the gateway answered a call with 303001 (endpoint suspended), which passes after a pause.
 */
const NOTIFY_RETRY_MS = [15_000, 45_000];

/**
 * When ABDM sent a request, from its TIMESTAMP header: ABDM's clock, so a server clock running ahead
 * of ABDM's cannot put a time taken from it in ABDM's future. A header with no zone is UTC, as ABDM
 * writes it. `now` when the header is missing, unreadable or later than `now`.
 */
export const abdmSentAt = (header: string | undefined, now: Date): Date => {
    const text = String(header ?? "").trim();
    if (!text) return now;
    const at = new Date(/(?:z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`);
    return Number.isFinite(at.getTime()) && at.getTime() <= now.getTime() ? at : now;
};

/** The bundles a care context shares, built from its records as they are now; none for a reference that is not one. */
export const bundlesForReference = async (records: Records, referenceNumber: string): Promise<HealthRecordBundle[]> => {
    const parsed = parseCareContextReference(referenceNumber);
    if (!parsed) return [];
    switch (parsed.kind) {
        case "visit": return records.forAppointment(Number(parsed.sourceId));
        case "discharge": return records.forDischargeSummary(Number(parsed.sourceId));
        case "immunization": return records.forImmunization(Number(parsed.sourceId));
        case "vitals": return records.forVitalsRecord(parsed.sourceId);
        case "prescription": return records.forPrescription(parsed.sourceId);
        case "consultation": return records.forConsultationRecord(parsed.sourceId);
        case "note": return records.forClinicalNote(Number(parsed.sourceId));
        case "document": return records.forDocument(Number(parsed.sourceId));
        case "report": return records.forDiagnosticReport(Number(parsed.sourceId));
        case "wellness": return records.forWellnessRecord(Number(parsed.sourceId));
        // A visit a Scan and Share opened holds no record of its own.
        case "share": return [];
    }
};

export interface StatusResponse {
    careContextReference: string;
    hiStatus: "DELIVERED" | "ERRORED";
    description: string;
}

const date = (v: unknown): Date | null => {
    const d = v ? new Date(String(v)) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
};

/** A record's own date: its Composition's. */
const recordDateOf = (b: HealthRecordBundle): Date | null =>
    date(b.bundle.entry.find((e) => e.resource.resourceType === "Composition")?.resource.date);

export class DataFlowService {
    constructor(
        private readonly store: M2Store,
        private readonly records: Records = abdmHealthRecordService,
        private readonly gateway: Gateway = abdmGatewayService,
        private readonly now: () => Date = () => new Date(),
        private readonly push: Push = (url, init) => fetch(url, init),
        private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ) {}

    private call(hip: Hip, operation: string, path: string, body: unknown, requestId?: string) {
        return this.gateway.call({ operation, host: "gateway", method: "POST", path, headers: { "X-HIP-ID": hip.id }, body, requestId });
    }

    /** consent notify → on-notify. A grant is stored whole; a revocation or expiry updates its status. */
    async onConsentNotify(hip: Hip, requestId: string, body: any): Promise<void> {
        const n = body?.notification ?? {};
        const detail = n.consentDetail ?? null;
        const consentId = String(n.consentId ?? detail?.consentId ?? "");
        if (consentId) {
            await this.store.saveConsent({
                consentId,
                hipId: hip.id,
                status: String(n.status ?? "UNKNOWN"),
                patientAbhaAddress: detail?.patient?.id ?? null,
                hiuId: detail?.hiu?.id ?? null,
                hiTypes: Array.isArray(detail?.hiTypes) ? detail.hiTypes : [],
                careContexts: Array.isArray(detail?.careContexts) ? detail.careContexts : [],
                dateFrom: date(detail?.permission?.dateRange?.from),
                dateTo: date(detail?.permission?.dateRange?.to),
                dataEraseAt: date(detail?.permission?.dataEraseAt),
                purpose: detail?.purpose?.code ?? null,
                artefact: detail ? JSON.stringify(detail) : null,
                signature: typeof n.signature === "string" ? n.signature : null,
            });
        }
        await this.call(hip, "consent/v3/request/hip/on-notify", "/api/hiecm/consent/v3/request/hip/on-notify", {
            acknowledgement: { status: "OK", consentId },
            response: { requestId },
        });
    }

    /** Why a health information request can't be served, or null when it can. */
    async refusal(hip: Hip, body: any): Promise<{ code: string; message: string } | null> {
        const hi = body?.hiRequest ?? {};
        const consent = hi.consent?.id ? await this.store.consent(String(hi.consent.id)) : null;
        if (!consent || consent.hipId !== hip.id) return { code: "ABDM-1112", message: "Invalid or already expired consent artefact id." };
        if (consent.status !== "GRANTED") return { code: "ABDM-1062", message: `Consent not granted (${consent.status}).` };
        if (consent.dataEraseAt && consent.dataEraseAt <= this.now()) return { code: "ABDM-1061", message: "Consent artefact expired." };
        const from = date(hi.dateRange?.from), to = date(hi.dateRange?.to);
        if (!from || !to || from > to) return { code: "ABDM-9999", message: "The requested date range is invalid." };
        if ((consent.dateFrom && from.getTime() < consent.dateFrom.getTime() - STORED_DATE_SLACK_MS)
            || (consent.dateTo && to.getTime() > consent.dateTo.getTime() + STORED_DATE_SLACK_MS)) {
            return { code: "ABDM-9999", message: "The requested date range is outside the consented range." };
        }
        if (!hi.dataPushUrl || !/^https?:\/\//i.test(String(hi.dataPushUrl))) return { code: "ABDM-9999", message: "No valid dataPushUrl." };
        try {
            decodePublicKey(String(hi.keyMaterial?.dhPublicKey?.keyValue ?? ""));
            if (Buffer.from(String(hi.keyMaterial?.nonce ?? ""), "base64").length !== 32) throw new HieCryptoError("nonce");
        } catch {
            return { code: "ABDM-9999", message: "The key material is not a Curve25519 key and 32 byte nonce." };
        }
        return null;
    }

    /** health-information request → on-request, then (when acknowledged) the transfer and notify. */
    async onHealthInformationRequest(hip: Hip, requestId: string, body: any, timestamp?: string): Promise<void> {
        // When ABDM initiated the transaction, by its own TIMESTAMP: the notify's doneAt (see transfer).
        // Our arrival time would still be in ABDM's future on a fast server clock when nothing is pushed.
        const now = this.now();
        const initiatedAt = abdmSentAt(timestamp, now);
        if (timestamp && initiatedAt === now) {
            console.warn(`[ABDM] health-information/request TIMESTAMP "${String(timestamp).slice(0, 40)}" is unreadable or after the server clock; doneAt uses the server clock`);
        }
        const transactionId = String(body?.transactionId ?? "");
        const consentId = String(body?.hiRequest?.consent?.id ?? "");
        const created = await this.store.createTransfer({
            transactionId, consentId, hipId: hip.id, requestId, dataPushUrl: body?.hiRequest?.dataPushUrl ?? null, status: "received",
        });
        if (created === "duplicate") return;

        const refused = await this.refusal(hip, body);
        try {
            await this.acknowledge(hip, {
                hiRequest: { transactionId, sessionStatus: refused ? "ERRORED" : "ACKNOWLEDGED" },
                ...(refused ? { error: refused } : {}),
                response: { requestId },
            });
        } catch (error: any) {
            await this.store.updateTransfer(transactionId, { status: "failed", error: `on-request: ${error?.message ?? "failed"}`, completed: true });
            throw error;
        }
        if (refused) {
            await this.store.updateTransfer(transactionId, { status: "refused", error: `${refused.code}: ${refused.message}`, completed: true });
            return;
        }
        await this.store.updateTransfer(transactionId, { status: "acknowledged" });
        await this.transfer(hip, transactionId, body, initiatedAt);
    }

    /** on-request, tried again while ABDM fails on its side: until it lands, nothing can be pushed. */
    private async acknowledge(hip: Hip, body: object): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            try {
                await this.call(hip, "data-flow/v3/health-information/hip/on-request", "/api/hiecm/data-flow/v3/health-information/hip/on-request", body);
                return;
            } catch (error: any) {
                if (attempt >= ON_REQUEST_RETRY_MS.length || !failedOnAbdmSide(error)) throw error;
                console.warn(`[ABDM] on-request failed on ABDM's side (${error.message}); trying again`);
                await this.wait(ON_REQUEST_RETRY_MS[attempt]!);
            }
        }
    }

    private bundlesFor(context: CareContextRow): Promise<HealthRecordBundle[]> {
        return bundlesForReference(this.records, context.referenceNumber);
    }

    /** Builds, encrypts and pushes what the consent covers, one page per care context, then notifies ABDM. */
    async transfer(hip: Hip, transactionId: string, body: any, initiatedAt: Date = this.now()): Promise<StatusResponse[]> {
        const hi = body.hiRequest;
        const consent = (await this.store.consent(String(hi.consent.id)))!;
        const from = new Date(Math.max(new Date(hi.dateRange.from).getTime(), consent.dateFrom?.getTime() ?? -Infinity));
        const to = new Date(Math.min(new Date(hi.dateRange.to).getTime(), consent.dateTo?.getTime() ?? Infinity));
        const allowed = new Set<HiType>(consent.hiTypes);
        const own = generateKeyMaterial();
        const peer = { publicKey: String(hi.keyMaterial.dhPublicKey.keyValue), nonce: String(hi.keyMaterial.nonce) };

        const statuses: StatusResponse[] = [];
        const pages: Array<{ reference: string; entries: object[] }> = [];
        const refs = consent.careContexts.map((c) => c.careContextReference);
        const rows = new Map((await this.store.careContextsByRefs(hip.id, refs)).map((r) => [r.referenceNumber, r]));
        const patientAbha = consent.patientAbhaAddress?.toLowerCase();
        // A care context linked under one of the patient's addresses serves a consent raised
        // against another of them: both belong to the same ABHA.
        const addressesOf = new Map<string, Promise<string[]>>();
        const consentingPatient = async (row: CareContextRow): Promise<boolean> => {
            if (!patientAbha || !row.linkedAbhaAddress || row.linkedAbhaAddress.toLowerCase() === patientAbha) return true;
            if (!addressesOf.has(row.patientUserId)) addressesOf.set(row.patientUserId, this.store.abhaAddresses(row.patientUserId));
            return (await addressesOf.get(row.patientUserId)!).includes(patientAbha);
        };

        for (const ref of refs) {
            const row = rows.get(ref);
            const errored = (description: string) => statuses.push({ careContextReference: ref, hiStatus: "ERRORED", description });
            if (!row) { errored("Unknown care context."); continue; }
            if (row.linkStatus !== "linked" || !(await consentingPatient(row))) {
                errored("This care context is not linked to the consenting patient."); continue;
            }
            try {
                const consented = (await this.bundlesFor(row)).filter((b) => allowed.has(b.hiType));
                if (!consented.length) { errored("No records of the consented types."); continue; }
                // Each record by its own date, not its care context's: a visit's prescription written
                // after the consented range ended is not shared, one written inside it is
                const bundles = consented.filter((b) => {
                    const at = recordDateOf(b) ?? row.recordDate;
                    return at >= from && at <= to;
                });
                if (!bundles.length) { errored("Outside the consented date range."); continue; }
                pages.push({
                    reference: ref,
                    entries: bundles.map((b) => {
                        const plain = JSON.stringify(b.bundle);
                        return { content: encrypt(plain, own, peer), media: "application/fhir+json", checksum: checksum(plain), careContextReference: ref };
                    }),
                });
            } catch (error: any) {
                console.warn(`[ABDM] transfer ${transactionId}: a care context could not be built: ${error?.message}`);
                errored("The records could not be prepared.");
            }
        }

        const token = pages.length ? await this.gateway.getAccessToken() : "";
        const expiry = new Date(this.now().getTime() + 24 * 60 * 60_000).toISOString();
        for (const [i, page] of pages.entries()) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
            try {
                const res = await this.push(String(hi.dataPushUrl), {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: JSON.stringify({
                        pageNumber: i + 1,
                        pageCount: pages.length,
                        transactionId,
                        entries: page.entries,
                        keyMaterial: {
                            cryptoAlg: "ECDH",
                            curve: "Curve25519",
                            dhPublicKey: { expiry, parameters: "Curve25519/32byte random key", keyValue: own.publicKey },
                            nonce: own.nonce,
                        },
                    }),
                    signal: controller.signal,
                });
                statuses.push(res.ok
                    ? { careContextReference: page.reference, hiStatus: "DELIVERED", description: "Delivered" }
                    : { careContextReference: page.reference, hiStatus: "ERRORED", description: `The requester answered HTTP ${res.status}.` });
            } catch (error: any) {
                statuses.push({ careContextReference: page.reference, hiStatus: "ERRORED", description: error?.name === "AbortError" ? "The requester did not answer in time." : "The requester could not be reached." });
            } finally {
                clearTimeout(timer);
            }
        }

        const delivered = statuses.some((s) => s.hiStatus === "DELIVERED");
        const status = delivered ? "transferred" : "failed";
        try {
            await this.notify(hip, transactionId, {
                notification: {
                    consentId: consent.consentId,
                    transactionId,
                    // "The date at which the transaction was initiated", not the moment of sending: a
                    // server clock a second fast puts that in ABDM's future, and ABDM refuses it.
                    doneAt: initiatedAt.toISOString(),
                    notifier: { type: "HIP", id: hip.id },
                    statusNotification: { sessionStatus: delivered ? "TRANSFERRED" : "FAILED", hipId: hip.id, statusResponses: statuses },
                },
            });
        } catch (error: any) {
            // Done but never reported to ABDM: kept with its results and closed, so it never looks in progress.
            const reason = error instanceof AbdmApiError && error.code ? `${error.code}: ${error.message}` : error?.message ?? "failed";
            await this.store.updateTransfer(transactionId, { status, results: statuses, error: `notify not sent: ${reason}`, completed: true });
            throw error;
        }
        await this.store.updateTransfer(transactionId, { status, results: statuses, completed: true });
        return statuses;
    }

    /**
     * health-information/notify, tried again while ABDM fails on its side: the same body each time,
     * doneAt included, under a fresh REQUEST-ID (ABDM refuses one already used, ABDM-1064). A refusal
     * (4xx) is not tried again. Every failed try is logged with its REQUEST-ID and outcome.
     */
    private async notify(hip: Hip, transactionId: string, body: object): Promise<void> {
        for (let attempt = 1; ; attempt++) {
            const requestId = randomUUID();
            const tries = `attempt ${attempt} of ${NOTIFY_RETRY_MS.length + 1}`;
            try {
                await this.call(hip, "data-flow/v3/health-information/notify", "/api/hiecm/data-flow/v3/health-information/notify", body, requestId);
                if (attempt > 1) console.log(`[ABDM] health-information/notify transactionId=${transactionId} sent REQUEST-ID=${requestId} (${tries})`);
                return;
            } catch (error: any) {
                const delay = isAbdmSideFailure(error) ? NOTIFY_RETRY_MS[attempt - 1] : undefined;
                console.warn(`[ABDM] health-information/notify transactionId=${transactionId} REQUEST-ID=${requestId} not sent (${tries}): ` +
                    `${error?.code ?? error?.kind ?? "error"}${delay === undefined ? "" : `; trying again in ${delay / 1000} s`}`);
                if (delay === undefined) throw error;
                await this.wait(delay);
            }
        }
    }
}
