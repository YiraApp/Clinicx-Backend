import { randomUUID } from "crypto";
import { AbdmApiError, abdmGatewayService, type AbdmGatewayService } from "../abdm-gateway.service.js";
import type { HiType } from "../fhir/fhir-common.js";
import { byHiType, CareContextCatalog, patientReference } from "./care-contexts.js";
import type { CareContextRow, Hip, M2Store, PatientProfile } from "./m2-store.js";

/**
 * HIP-initiated linking: the clinic links a patient's care contexts to their ABHA with a link
 * token. The token is asked for once (generate-token, answered on on-generate-token), kept for
 * its validity (about six months) and reused; linking (link/carecontext, answered on
 * on_carecontext) waits for it when there is none yet. A linked care context that gains records
 * is announced with link/context/notify.
 */

type Gateway = Pick<AbdmGatewayService, "call">;

/** Token refusals that mean the stored token is no good: drop it and ask again. */
const BAD_TOKEN = new Set(["ABDM-1026", "ABDM-1038", "ABDM-1062", "ABDM-1063", "ABDM-1065", "ABDM-1066"]);
const TOKEN_MARGIN_MS = 60 * 60_000;
/** How long an answer from ABDM is waited on before the care contexts may be linked again: it may never come. */
const ANSWER_WAIT_MS = 10 * 60_000;
const NO_ANSWER = "ABDM did not answer in time. Link again.";
const SIX_MONTHS_MS = 182 * 24 * 60 * 60_000;

const GENDER: Record<string, string> = { male: "M", m: "M", female: "F", f: "F", other: "O", o: "O" };

export class LinkingError extends Error {
    constructor(message: string, readonly status = 422) {
        super(message);
        this.name = "LinkingError";
    }
}

const linkKey = (hip: Hip, userId: string): string => `${hip.id}|${patientReference(userId)}`;

/** When a link token runs out: its exp claim, read without verifying (it is ABDM's to verify). */
export const tokenExpiry = (token: string, now: Date): Date => {
    try {
        const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
        if (typeof claims.exp === "number") return new Date(claims.exp * 1000);
    } catch { /* not a JWT: fall through */ }
    return new Date(now.getTime() + SIX_MONTHS_MS);
};

export class HipLinkingService {
    /** Requests (token or link) this server sent and is waiting on an answer for, by REQUEST-ID: when each went. */
    private readonly inFlight = new Map<string, number>();
    /** One link at a time per facility and patient: a click and an auto-link at once would ask for two tokens. */
    private readonly queues = new Map<string, Promise<unknown>>();

    constructor(
        private readonly store: M2Store,
        private readonly catalog: CareContextCatalog,
        private readonly gateway: Gateway = abdmGatewayService,
        private readonly now: () => Date = () => new Date(),
    ) {}

    private async patient(userId: string): Promise<PatientProfile> {
        const p = await this.store.patient(userId);
        if (!p) throw new LinkingError("Patient not found.", 404);
        return p;
    }

    /**
     * Links every care context the patient has here that is not linked yet. Returns at once: the
     * outcome arrives on callbacks and shows in the care contexts' link status.
     */
    async link(hip: Hip, userId: string): Promise<{ queued: number; status: string }> {
        const key = linkKey(hip, userId);
        const run = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.linkNow(hip, userId));
        this.queues.set(key, run);
        try {
            return await run;
        } finally {
            if (this.queues.get(key) === run) this.queues.delete(key);
        }
    }

    private async linkNow(hip: Hip, userId: string): Promise<{ queued: number; status: string }> {
        const patient = await this.patient(userId);
        if (!patient.abhaAddress) throw new LinkingError("The patient has no ABHA address yet: verify or create their ABHA first.");

        const contexts = await this.expireStale(await this.catalog.refresh(hip, userId));
        const pending = contexts.filter((c) => c.hiTypes.length && (c.linkStatus === "not-linked" || c.linkStatus === "failed"));
        if (!pending.length) return { queued: 0, status: "nothing to link" };

        const token = await this.store.linkToken(patientReference(userId), hip.id, new Date(this.now().getTime() + TOKEN_MARGIN_MS));
        if (token && token.abhaAddress.toLowerCase() === patient.abhaAddress.toLowerCase()) {
            await this.sendLink(hip, patient, token.token, pending);
            return { queued: pending.length, status: "linking" };
        }
        const asked = contexts.find((c) => c.linkStatus === "awaiting-token" && c.linkRequestId)?.linkRequestId;
        if (asked) {
            // A token asked for moments ago is still on its way: these wait for it too. Asking again
            // for the same patient is refused as a duplicate (ABDM-1092).
            await this.store.setLinkState(pending.map((c) => c.id), { linkStatus: "awaiting-token", linkRequestId: asked, lastError: null });
            return { queued: pending.length, status: "awaiting-token" };
        }
        const requestId = await this.requestToken(hip, patient, pending);
        return { queued: pending.length, status: requestId ? "awaiting-token" : "failed" };
    }

    /** Asks ABDM for a link token; the care contexts wait for it under the request's id. */
    private async requestToken(hip: Hip, patient: PatientProfile, waiting: CareContextRow[]): Promise<string | null> {
        const gender = GENDER[(patient.gender ?? "").trim().toLowerCase()];
        const yearOfBirth = Number(patient.birthDate?.slice(0, 4));
        if (!gender || !Number.isInteger(yearOfBirth) || yearOfBirth < 1900) {
            await this.store.setLinkState(waiting.map((c) => c.id), { linkStatus: "failed", lastError: "The patient's gender and date of birth are needed to ask ABDM for a link token." });
            throw new LinkingError("The patient's gender and date of birth are needed to ask ABDM for a link token.");
        }
        const requestId = randomUUID();
        await this.store.setLinkState(waiting.map((c) => c.id), { linkStatus: "awaiting-token", linkRequestId: requestId, lastError: null });
        try {
            await this.gateway.call({
                operation: "hiecm/v3/token/generate-token",
                host: "gateway",
                method: "POST",
                path: "/api/hiecm/v3/token/generate-token",
                headers: { "X-HIP-ID": hip.id },
                awaitsCallback: true,
                requestId,
                body: {
                    ...(patient.abhaNumber ? { abhaNumber: Number(patient.abhaNumber.replace(/\D/g, "")) } : {}),
                    abhaAddress: patient.abhaAddress,
                    name: patient.name,
                    gender,
                    yearOfBirth,
                },
            });
            this.inFlight.set(requestId, this.now().getTime());
            return requestId;
        } catch (error) {
            const message = error instanceof AbdmApiError ? `${error.message}${error.code ? ` (${error.code})` : ""}` : "ABDM could not be reached.";
            // A timeout may still have been accepted: the callback can still arrive and continue.
            const stillWaiting = error instanceof AbdmApiError && error.status === 0;
            await this.store.setLinkState(waiting.map((c) => c.id), stillWaiting ? { lastError: message } : { linkStatus: "failed", lastError: message });
            if (!stillWaiting) return null;
            this.inFlight.set(requestId, this.now().getTime());
            return requestId;
        }
    }

    private async sendLink(hip: Hip, patient: PatientProfile, token: string, contexts: CareContextRow[], retried = false): Promise<void> {
        const requestId = randomUUID();
        await this.store.setLinkState(contexts.map((c) => c.id), { linkStatus: "linking", linkRequestId: requestId, lastError: null });
        try {
            await this.gateway.call({
                operation: "hiecm/hip/v3/link/carecontext",
                host: "gateway",
                method: "POST",
                path: "/api/hiecm/hip/v3/link/carecontext",
                headers: { "X-HIP-ID": hip.id, "X-LINK-TOKEN": token },
                awaitsCallback: true,
                requestId,
                body: {
                    ...(patient.abhaNumber ? { abhaNumber: Number(patient.abhaNumber.replace(/\D/g, "")) } : {}),
                    abhaAddress: patient.abhaAddress,
                    patient: byHiType(patientReference(patient.userId), patient.name, contexts),
                },
            });
            this.inFlight.set(requestId, this.now().getTime());
        } catch (error) {
            if (error instanceof AbdmApiError && error.code && BAD_TOKEN.has(error.code) && !retried) {
                await this.store.dropLinkTokens(patientReference(patient.userId), hip.id);
                await this.requestToken(hip, patient, contexts);
                return;
            }
            const stillWaiting = error instanceof AbdmApiError && error.status === 0;
            const message = error instanceof AbdmApiError ? `${error.message}${error.code ? ` (${error.code})` : ""}` : "ABDM could not be reached.";
            await this.store.setLinkState(contexts.map((c) => c.id), stillWaiting ? { lastError: message } : { linkStatus: "failed", lastError: message });
            if (stillWaiting) this.inFlight.set(requestId, this.now().getTime());
        }
    }

    /**
     * Care contexts waiting on an answer from ABDM that has not come: asked more than ten minutes
     * ago, or before this server started (it no longer knows when). They are marked failed with the
     * reason, so the desk can link them again and the next save retries them. An answer that still
     * arrives is applied all the same.
     */
    async expireStale(contexts: CareContextRow[]): Promise<CareContextRow[]> {
        const now = this.now().getTime();
        const stale = contexts.filter((c) => (c.linkStatus === "awaiting-token" || c.linkStatus === "linking")
            && !(c.linkRequestId && now - (this.inFlight.get(c.linkRequestId) ?? -Infinity) < ANSWER_WAIT_MS));
        if (!stale.length) return contexts;
        await this.store.setLinkState(stale.map((c) => c.id), { linkStatus: "failed", lastError: NO_ANSWER });
        return contexts.map((c) => (stale.includes(c) ? { ...c, linkStatus: "failed" as const, lastError: NO_ANSWER } : c));
    }

    /** on-generate-token: keep the token and link what was waiting for it, or record why not. */
    async onLinkToken(hip: Hip, answeredRequestId: string, body: any): Promise<void> {
        const waiting = await this.store.careContextsByLinkRequest(answeredRequestId);
        if (!waiting.length) return;
        const patient = await this.patient(waiting[0]!.patientUserId);
        this.inFlight.delete(answeredRequestId);
        if (typeof body?.linkToken !== "string" || !body.linkToken) {
            const reason = body?.error?.message ? `${body.error.message}${body.error.code ? ` (${String(body.error.code).replace(/:\s*$/, "")})` : ""}` : "ABDM gave no link token.";
            await this.store.setLinkState(waiting.map((c) => c.id), { linkStatus: "failed", lastError: reason });
            return;
        }
        await this.store.saveLinkToken({
            patientUserId: patientReference(patient.userId),
            hipId: hip.id,
            abhaAddress: String(body.abhaAddress ?? patient.abhaAddress),
            token: body.linkToken,
            expiresAt: tokenExpiry(body.linkToken, this.now()),
            requestId: answeredRequestId,
        });
        // Those given up on as unanswered are linked too: the token they waited for is here after all.
        const toLink = waiting.filter((c) => c.linkStatus === "awaiting-token" || (c.linkStatus === "failed" && c.lastError === NO_ANSWER));
        if (toLink.length) await this.sendLink(hip, patient, body.linkToken, toLink);
    }

    /** on_carecontext: the care contexts sent under that request are linked, or why not. */
    async onLinkResult(answeredRequestId: string, body: any): Promise<void> {
        this.inFlight.delete(answeredRequestId);
        const contexts = await this.store.careContextsByLinkRequest(answeredRequestId);
        if (!contexts.length) return;
        const linked = typeof body?.status === "string" && /success/i.test(body.status) && !body?.error;
        if (linked) {
            for (const c of contexts) {
                await this.store.setLinkState([c.id], {
                    linkStatus: "linked", linkedVia: "hip", linkedAbhaAddress: body.abhaAddress ?? null, linkedAt: this.now(), notifiedHiTypes: c.hiTypes, lastError: null,
                });
            }
            return;
        }
        const reason = body?.error?.message ?? body?.status ?? "ABDM did not link the care contexts.";
        await this.store.setLinkState(contexts.map((c) => c.id), { linkStatus: "failed", lastError: String(reason) });
    }

    /**
     * Tells ABDM about records added to care contexts already linked: one link/context/notify per
     * care context whose HI types grew since it was linked or last announced.
     */
    async notifyChanges(hip: Hip, userId: string): Promise<number> {
        const patient = await this.patient(userId);
        if (!patient.abhaAddress) return 0;
        const contexts = await this.catalog.refresh(hip, userId);
        let sent = 0;
        for (const c of contexts.filter((x) => x.linkStatus === "linked")) {
            const added = c.hiTypes.filter((t) => !c.notifiedHiTypes.includes(t));
            if (!added.length) continue;
            try {
                await this.gateway.call({
                    operation: "hiecm/hip/v3/link/context/notify",
                    host: "gateway",
                    method: "POST",
                    path: "/api/hiecm/hip/v3/link/context/notify",
                    headers: { "X-HIP-ID": hip.id },
                    awaitsCallback: true,
                    body: {
                        notification: {
                            patient: { id: c.linkedAbhaAddress ?? patient.abhaAddress },
                            careContext: { patientReference: patientReference(userId), careContextReference: c.referenceNumber },
                            hiTypes: added,
                            date: this.now().toISOString(),
                            hip: { id: hip.id },
                        },
                    },
                });
                await this.store.setLinkState([c.id], { notifiedHiTypes: [...new Set([...c.notifiedHiTypes, ...added])] as HiType[], lastError: null });
                sent++;
            } catch (error: any) {
                await this.store.setLinkState([c.id], { lastError: `Notify failed: ${error?.message ?? "unknown"}` });
            }
        }
        return sent;
    }

    /** Asks ABDM to text the patient a link to view their records here (the deep-link journey). */
    async smsNotify(hip: Hip, userId: string): Promise<{ requestId: string }> {
        const patient = await this.patient(userId);
        const digits = (patient.phone ?? "").replace(/\D/g, "").slice(-10);
        if (digits.length !== 10) throw new LinkingError("The patient has no 10 digit mobile number on record.");
        const requestId = randomUUID();
        await this.gateway.call({
            operation: "hiecm/hip/v3/link/patient/links/sms/notify2",
            host: "gateway",
            method: "POST",
            path: "/api/hiecm/hip/v3/link/patient/links/sms/notify2",
            headers: { "X-HIP-ID": hip.id },
            awaitsCallback: true,
            requestId,
            body: { notification: { phoneNo: digits, hip: { id: hip.id, name: hip.name } } },
        });
        return { requestId };
    }

    /** Links and announces new records for every patient who holds an ABHA, at each of these facilities. */
    async sweep(facilities: Hip[]): Promise<{ patients: number; queued: number; notified: number }> {
        let patients = 0, queued = 0, notified = 0;
        for (const hip of facilities) {
            const userIds = await this.store.patientsWithAbhaAt(hip.hospitalId);
            patients += userIds.length;
            for (const userId of userIds) {
                try {
                    queued += (await this.link(hip, userId)).queued;
                    notified += await this.notifyChanges(hip, userId);
                } catch (error: any) {
                    console.warn(`[ABDM] linking sweep skipped a patient at ${hip.id}: ${error?.message}`);
                }
            }
        }
        return { patients, queued, notified };
    }
}
