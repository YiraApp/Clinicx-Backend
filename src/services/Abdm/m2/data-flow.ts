import { abdmGatewayService, type AbdmGatewayService } from "../abdm-gateway.service.js";
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
type Records = Pick<AbdmHealthRecordService,
    "forAppointment" | "forDischargeSummary" | "forImmunization" | "forVitalsRecord" | "forPrescription" | "forConsultationRecord" | "forClinicalNote" | "forDocument">;
type Push = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

const PUSH_TIMEOUT_MS = 60_000;
/**
 * AbdmConsents keeps the consented dates as SQL Server datetime, which rounds milliseconds to
 * .000, .003 or .007: a request for exactly the consented range (…48.061Z) reads as 1 ms past
 * the stored end (…48.060Z). Seen 2026-10-26 on PHR app fetches, which ask for exactly that.
 */
const STORED_DATE_SLACK_MS = 4;

export interface StatusResponse {
    careContextReference: string;
    hiStatus: "DELIVERED" | "ERRORED";
    description: string;
}

const date = (v: unknown): Date | null => {
    const d = v ? new Date(String(v)) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
};

export class DataFlowService {
    constructor(
        private readonly store: M2Store,
        private readonly records: Records = abdmHealthRecordService,
        private readonly gateway: Gateway = abdmGatewayService,
        private readonly now: () => Date = () => new Date(),
        private readonly push: Push = (url, init) => fetch(url, init),
    ) {}

    private call(hip: Hip, operation: string, path: string, body: unknown) {
        return this.gateway.call({ operation, host: "gateway", method: "POST", path, headers: { "X-HIP-ID": hip.id }, body });
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
    async onHealthInformationRequest(hip: Hip, requestId: string, body: any): Promise<void> {
        const transactionId = String(body?.transactionId ?? "");
        const consentId = String(body?.hiRequest?.consent?.id ?? "");
        const created = await this.store.createTransfer({
            transactionId, consentId, hipId: hip.id, requestId, dataPushUrl: body?.hiRequest?.dataPushUrl ?? null, status: "received",
        });
        if (created === "duplicate") return;

        const refused = await this.refusal(hip, body);
        await this.call(hip, "data-flow/v3/health-information/hip/on-request", "/api/hiecm/data-flow/v3/health-information/hip/on-request", {
            hiRequest: { transactionId, sessionStatus: refused ? "ERRORED" : "ACKNOWLEDGED" },
            ...(refused ? { error: refused } : {}),
            response: { requestId },
        });
        if (refused) {
            await this.store.updateTransfer(transactionId, { status: "refused", error: `${refused.code}: ${refused.message}`, completed: true });
            return;
        }
        await this.store.updateTransfer(transactionId, { status: "acknowledged" });
        await this.transfer(hip, transactionId, body);
    }

    private async bundlesFor(context: CareContextRow): Promise<HealthRecordBundle[]> {
        const parsed = parseCareContextReference(context.referenceNumber);
        if (!parsed) return [];
        switch (parsed.kind) {
            case "visit": return this.records.forAppointment(Number(parsed.sourceId));
            case "discharge": return this.records.forDischargeSummary(Number(parsed.sourceId));
            case "immunization": return this.records.forImmunization(Number(parsed.sourceId));
            case "vitals": return this.records.forVitalsRecord(parsed.sourceId);
            case "prescription": return this.records.forPrescription(parsed.sourceId);
            case "consultation": return this.records.forConsultationRecord(parsed.sourceId);
            case "note": return this.records.forClinicalNote(Number(parsed.sourceId));
            case "document": return this.records.forDocument(Number(parsed.sourceId));
        }
    }

    /** Builds, encrypts and pushes what the consent covers, one page per care context, then notifies ABDM. */
    async transfer(hip: Hip, transactionId: string, body: any): Promise<StatusResponse[]> {
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

        for (const ref of refs) {
            const row = rows.get(ref);
            const errored = (description: string) => statuses.push({ careContextReference: ref, hiStatus: "ERRORED", description });
            if (!row) { errored("Unknown care context."); continue; }
            if (row.linkStatus !== "linked" || (patientAbha && row.linkedAbhaAddress && row.linkedAbhaAddress.toLowerCase() !== patientAbha)) {
                errored("This care context is not linked to the consenting patient."); continue;
            }
            if (row.recordDate < from || row.recordDate > to) { errored("Outside the consented date range."); continue; }
            try {
                const bundles = (await this.bundlesFor(row)).filter((b) => allowed.has(b.hiType));
                if (!bundles.length) { errored("No records of the consented types."); continue; }
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
        await this.call(hip, "data-flow/v3/health-information/notify", "/api/hiecm/data-flow/v3/health-information/notify", {
            notification: {
                consentId: consent.consentId,
                transactionId,
                doneAt: this.now().toISOString(),
                notifier: { type: "HIP", id: hip.id },
                statusNotification: { sessionStatus: delivered ? "TRANSFERRED" : "FAILED", hipId: hip.id, statusResponses: statuses },
            },
        });
        await this.store.updateTransfer(transactionId, { status: delivered ? "transferred" : "failed", results: statuses, completed: true });
        return statuses;
    }
}
