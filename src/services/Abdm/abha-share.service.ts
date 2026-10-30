import { abdmConfig } from "../../config/abdm.config.js";
import { abdmGatewayService, type AbdmGatewayService } from "./abdm-gateway.service.js";
import { abdmFacilities, type AbdmFacilityDirectory } from "./abdm-facilities.service.js";
import { AbhaJourneyError, text, textOrNull } from "./abha-enrolment.service.js";
import { normalizeAbhaNumber } from "./abha-login.service.js";

/**
 * ABDM Scan and Share at the counter (SHARE_PATIENT_PROFILE_701/702): the patient scans the
 * counter's QR code in their ABHA app and agrees to share; ABDM posts their profile to
 * /api/v3/hip/patient/share. We answer 200 at once, then register or match the patient with
 * nothing typed at the desk, give them a queue token, and send it back on on-share.
 *
 * Matching: the ABHA number first, then the ABHA address, then name, mobile, gender and year of
 * birth. Exactly one match reuses that patient; none creates one; more than one is left for the
 * desk (REVIEW), because guessing would merge two people. A repeat scan at the same counter while
 * its token is still valid keeps that token and adds no queue entry (REPEAT); another counter
 * gets its own.
 */

export interface SharedPatient {
    abhaNumber: string | null;
    abhaAddress: string;
    name: string;
    firstName: string;
    lastName: string;
    /** Male, Female or Other, as the clinic records it. */
    gender: string | null;
    /** YYYY-MM-DD, only when ABDM sent the whole date. */
    dateOfBirth: string | null;
    yearOfBirth: string | null;
    /** Last 10 digits. */
    phone: string | null;
    address: { line: string | null; district: string | null; state: string | null; pincode: string | null };
}

export interface ParsedShare {
    hipId: string;
    /** The hospital whose counter QR code carries that HIP id (AbdmFacilities). */
    hospitalId: number;
    counterId: string;
    patient: SharedPatient;
}

/** REPEAT: a rescan answered with the live token of an earlier share; it is not a queue entry of its own. */
export type ShareStatus = "RECEIVED" | "REGISTERED" | "REVIEW" | "ACKNOWLEDGED" | "REPEAT" | "FAILED";
export type ShareMatch = "NEW" | "ABHA_NUMBER" | "ABHA_ADDRESS" | "DEMOGRAPHIC" | "AMBIGUOUS";

export interface ShareRow {
    id: number;
    requestId: string;
    hipId: string;
    counterId: string;
    abhaNumber: string | null;
    abhaAddress: string;
    patientName: string | null;
    userId: string | null;
    hospitalId: number | null;
    tokenNumber: string | null;
    expiresAt: Date | null;
    status: ShareStatus;
    matchType: ShareMatch | null;
    error: string | null;
    createdAt: Date;
}

/**
 * Opens the visit's care context under the patient (SHARE_PATIENT_PROFILE_702). Returns its
 * reference, or null when there is nothing to open (no HIP at the hospital, or already open).
 */
export interface ShareVisits {
    opened(visit: { hospitalId: number; userId: string; shareId: number; at: Date }): Promise<string | null>;
}

/** What Scan and Share reads and writes in the clinic database. */
export interface AbhaShareStore {
    findShareByRequestId(requestId: string): Promise<ShareRow | null>;
    createShare(row: Omit<ShareRow, "id" | "createdAt">): Promise<number>;
    updateShare(id: number, changes: Partial<Omit<ShareRow, "id" | "createdAt">>): Promise<void>;
    /** The newest share for this patient at this counter whose token is still valid. */
    findActiveShare(input: { userId: string; hospitalId: number; counterId: string; now: Date }): Promise<ShareRow | null>;
    /** The highest numeric token issued today at this counter, or 0. */
    maxTokenToday(input: { hospitalId: number; counterId: string; since: Date }): Promise<number>;
    /** The queue entries since [since], newest first: every share except a REPEAT. */
    listShares(input: { hospitalId: number; since: Date; counterId?: string }): Promise<ShareRow[]>;
    /** One patient's queue entries at the hospital since [since], every one (no cap), any order; no REPEAT. */
    listPatientShares(input: { hospitalId: number; userId: string; since: Date }): Promise<ShareRow[]>;
    /** [abhaNumber] is the dashed form; a number stored as 14 bare digits matches too. */
    findPatientIdByAbhaNumber(abhaNumber: string): Promise<string | null>;
    /** Live patients holding the shared ABHA address and no other ABHA number. */
    findPatientIdsByAbhaAddress(patient: SharedPatient): Promise<string[]>;
    /** Live patients matching name, mobile, gender and year of birth, who hold no other ABHA number. */
    findPatientIdsByDemographics(patient: SharedPatient): Promise<string[]>;
    /** Creates the patient (user, address, patient role and registration at [hospitalId]). Returns the user id. */
    createPatient(patient: SharedPatient, hospitalId: number): Promise<string>;
    /** Records the ABHA on an existing patient and makes sure they are registered at [hospitalId]. */
    updatePatientAbha(userId: string, patient: SharedPatient, hospitalId: number): Promise<void>;
}

const GENDERS: Record<string, string> = { M: "Male", F: "Female", O: "Other", T: "Other", D: "Other", U: "Other" };
const COUNTER_ID = /^[A-Za-z0-9]{1,20}$/;
/** AbhaProfileShares.CounterId is VARCHAR(20); ABDM allows a context of up to 250 characters. */
const COUNTER_ID_MAX = 20;

const startOfToday = (now: number): Date => {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    return day;
};

/** On-share "expiry": the time the token has left, in the unit ABDM reads (ABDM_SHARE_EXPIRY_UNIT), never below 1. */
const expiryForAbdm = (expiresAt: Date, now: number): number =>
    Math.max(1, Math.floor((new Date(expiresAt).getTime() - now) / (abdmConfig.shareExpiryUnit === "seconds" ? 1_000 : 60_000)));

/** The URL a counter's QR code holds; the patient's ABHA app opens it. */
export const counterShareUrl = (hipId: string, counterId: string): string =>
    `${abdmConfig.phrBaseUrl}/share-profile?hip-id=${encodeURIComponent(hipId)}&counter-id=${encodeURIComponent(counterId)}`;

export const assertCounterId = (counterId: unknown): string => {
    const id = String(counterId ?? "").trim();
    if (!COUNTER_ID.test(id)) {
        throw new AbhaJourneyError(400, "validation", "A counter id is 1 to 20 letters or digits, such as OPD1.", { field: "counterId" });
    }
    return id;
};

export class AbhaShareService {
    private readonly store: AbhaShareStore;
    private readonly gateway: Pick<AbdmGatewayService, "call">;
    private readonly clock: () => number;
    private readonly facilities: Pick<AbdmFacilityDirectory, "byScanShareHipId">;
    private readonly visits: ShareVisits | null;
    /** The tail of each (hospital, counter) token allocation chain. */
    private readonly tokenLocks = new Map<string, Promise<void>>();

    constructor(
        store: AbhaShareStore,
        gateway: Pick<AbdmGatewayService, "call"> = abdmGatewayService,
        clock: () => number = Date.now,
        facilities: Pick<AbdmFacilityDirectory, "byScanShareHipId"> = abdmFacilities,
        visits: ShareVisits | null = null,
    ) {
        this.store = store;
        this.gateway = gateway;
        this.clock = clock;
        this.facilities = facilities;
        this.visits = visits;
    }

    /** Validates ABDM's share body before we answer it. Throws an AbhaJourneyError for a share we must refuse. */
    async parse(hipIdHeader: unknown, body: any): Promise<ParsedShare> {
        if (body?.intent !== "PROFILE_SHARE") {
            throw new AbhaJourneyError(400, "validation", "Only PROFILE_SHARE is handled here.");
        }
        const hipId = text(body?.metaData?.hipId) || text(hipIdHeader);
        const facility = hipId && !(text(hipIdHeader) && text(hipIdHeader) !== hipId) ? await this.facilities.byScanShareHipId(hipId) : null;
        if (!facility) {
            throw new AbhaJourneyError(403, "validation", "This share is not for a HIP this system serves.");
        }
        const counterId = text(body?.metaData?.context);
        if (!counterId) {
            throw new AbhaJourneyError(400, "validation", "The share carries no counter id (metaData.context).");
        }
        if (counterId.length > COUNTER_ID_MAX) {
            throw new AbhaJourneyError(400, "validation", `The counter id (metaData.context) is longer than ${COUNTER_ID_MAX} characters.`);
        }

        const p = body?.profile?.patient ?? {};
        const abhaAddress = text(p.abhaAddress);
        const name = text(p.name).replace(/\s+/g, " ");
        if (!abhaAddress || !name) {
            throw new AbhaJourneyError(400, "validation", "The shared profile has no ABHA address or name.");
        }
        const [firstName = "", ...rest] = name.split(" ");
        const year = text(String(p.yearOfBirth ?? ""));
        const month = text(String(p.monthOfBirth ?? ""));
        const day = text(String(p.dayOfBirth ?? ""));
        const wholeDate = /^\d{4}$/.test(year) && /^\d{1,2}$/.test(month) && /^\d{1,2}$/.test(day);
        const digits = text(String(p.phoneNumber ?? "")).replace(/\D/g, "");

        return {
            hipId,
            hospitalId: facility.hospitalId,
            counterId,
            patient: {
                // Stored and matched in the dashed form, whichever form ABDM sends; anything else is dropped.
                abhaNumber: normalizeAbhaNumber(p.abhaNumber),
                abhaAddress,
                name,
                firstName,
                lastName: rest.join(" "),
                gender: GENDERS[text(p.gender).toUpperCase()] ?? null,
                dateOfBirth: wholeDate ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` : null,
                yearOfBirth: /^\d{4}$/.test(year) ? year : null,
                phone: digits.length >= 10 ? digits.slice(-10) : null,
                address: {
                    line: textOrNull(p.address?.line),
                    district: textOrNull(p.address?.district),
                    state: textOrNull(p.address?.state),
                    pincode: textOrNull(p.address?.pincode),
                },
            },
        };
    }

    /**
     * Registers or matches the patient, issues the queue token and answers ABDM on on-share.
     * A REQUEST-ID already seen is a retry of the same share and is not processed twice. Every
     * other share is answered, with an error if anything here fails.
     */
    async process(requestId: string, share: ParsedShare): Promise<void> {
        const { patient, counterId, hospitalId } = share;
        let shareId: number | null = null;
        let repeated = false;

        try {
            if (await this.store.findShareByRequestId(requestId)) {
                console.log(`[ABDM] Share REQUEST-ID=${requestId} already handled; ignoring the retry`);
                return;
            }
            const id = await this.recordShare(requestId, share, hospitalId);
            if (id === null) {
                console.log(`[ABDM] Share REQUEST-ID=${requestId} is being handled by a concurrent retry; ignoring this one`);
                return;
            }
            shareId = id;

            let userId: string | null = null;
            let matchType: ShareMatch;
            const byAbha = patient.abhaNumber ? await this.store.findPatientIdByAbhaNumber(patient.abhaNumber) : null;
            const byAddress = byAbha ? [] : await this.store.findPatientIdsByAbhaAddress(patient);
            if (byAbha) {
                userId = byAbha;
                matchType = "ABHA_NUMBER";
            } else if (byAddress.length === 1) {
                userId = byAddress[0]!;
                matchType = "ABHA_ADDRESS";
            } else if (byAddress.length > 1) {
                matchType = "AMBIGUOUS";
            } else {
                const candidates = await this.store.findPatientIdsByDemographics(patient);
                if (candidates.length === 1) {
                    userId = candidates[0]!;
                    matchType = "DEMOGRAPHIC";
                } else if (candidates.length > 1) {
                    matchType = "AMBIGUOUS";
                } else {
                    userId = await this.store.createPatient(patient, hospitalId);
                    matchType = "NEW";
                }
            }
            if (userId && matchType !== "NEW") {
                await this.store.updatePatientAbha(userId, patient, hospitalId);
            }

            // One allocation at a time per counter, so two patients scanning together never share a number.
            // Keyed without case: the database compares counter ids that way, so OPD1 and opd1 are one queue.
            const { tokenNumber, expiry, repeat, repeatOf } = await this.withTokenLock(`${hospitalId}|${counterId.toUpperCase()}`, async () => {
                // Same patient, same counter, token still valid: that token again, and no new queue entry.
                const now = this.clock();
                const active = userId ? await this.store.findActiveShare({ userId, hospitalId, counterId, now: new Date(now) }) : null;
                const tokenNumber = active?.tokenNumber
                    ?? String((await this.store.maxTokenToday({ hospitalId, counterId, since: startOfToday(now) })) + 1);
                const expiresAt = active?.expiresAt ?? new Date(now + abdmConfig.shareTokenExpiry * 60_000);

                await this.store.updateShare(id, {
                    userId,
                    matchType,
                    tokenNumber,
                    expiresAt,
                    status: active ? "REPEAT" : matchType === "AMBIGUOUS" ? "REVIEW" : "REGISTERED",
                });
                return { tokenNumber, expiry: expiryForAbdm(expiresAt, now), repeat: Boolean(active), repeatOf: active?.id ?? null };
            });
            repeated = repeat;

            await this.onShare({
                acknowledgement: {
                    status: "SUCCESS",
                    abhaAddress: patient.abhaAddress,
                    profile: { context: counterId, tokenNumber, expiry },
                },
                response: { requestId },
            });
            if (!repeat && matchType !== "AMBIGUOUS") {
                await this.store.updateShare(id, { status: "ACKNOWLEDGED" });
            }
            // A rescan belongs to the entry it repeats: should that visit's care context have failed to
            // open, it is opened now (opening is insert only, so an open one is left as it is).
            const careContext = userId && matchType !== "AMBIGUOUS" ? await this.openVisit(requestId, repeatOf ?? id, userId, hospitalId) : null;
            console.log(`[ABDM] Share REQUEST-ID=${requestId} counter=${counterId} match=${matchType} token=${tokenNumber}${repeat ? " (repeat)" : ""}${careContext ? ` care context ${careContext}` : ""}`);
        } catch (error: any) {
            const reason = String(error?.message || error).slice(0, 500);
            console.error(`[ABDM] Share REQUEST-ID=${requestId} failed: ${reason}`);
            if (shareId !== null) {
                // A repeat stays out of the queue even when its answer fails; the entry it repeats is unchanged.
                await this.store.updateShare(shareId, repeated ? { error: reason } : { status: "FAILED", error: reason }).catch(() => undefined);
            }
            // A failure is answered with the error alone: an acknowledgement would have to carry a profile.
            await this.onShare({
                error: { code: "ABDM-9999", message: "The facility could not register this share. Please ask at the counter." },
                response: { requestId },
            }).catch((ackError: any) => console.error(`[ABDM] on-share for REQUEST-ID=${requestId} failed too: ${ackError?.message}`));
        }
    }

    /**
     * The visit's care context under the patient, after the answer to ABDM (it never delays or fails
     * the share). A visit is a run of the patient's queue entries here whose tokens overlap: a scan
     * while one of their tokens is still valid, at any counter, joins that visit; one after every
     * token ran out starts a new visit, named by its first entry. When each token was issued is read
     * from its expiry (the database stamps CreatedAt with its own clock).
     */
    private async openVisit(requestId: string, shareId: number, userId: string, hospitalId: number): Promise<string | null> {
        if (!this.visits) return null;
        try {
            const now = this.clock();
            const lifetime = abdmConfig.shareTokenExpiry * 60_000;
            const entries = (await this.store.listPatientShares({ hospitalId, userId, since: startOfToday(now) }))
                .filter((row) => row.userId?.toLowerCase() === userId.toLowerCase()
                    && (row.status === "REGISTERED" || row.status === "ACKNOWLEDGED") && row.expiresAt !== null)
                .sort((a, b) => a.id - b.id);
            let visit = shareId;
            let liveUntil = -Infinity;
            for (const entry of entries) {
                const expires = new Date(entry.expiresAt!).getTime();
                if (expires - lifetime >= liveUntil) visit = entry.id;
                liveUntil = Math.max(liveUntil, expires);
                if (entry.id === shareId) break;
            }
            if (!entries.some((entry) => entry.id === shareId)) visit = shareId;
            return await this.visits.opened({ hospitalId, userId, shareId: visit, at: new Date(now) });
        } catch (error: any) {
            console.warn(`[ABDM] Share REQUEST-ID=${requestId}: the visit's care context was not opened: ${String(error?.message || error).slice(0, 200)}`);
            return null;
        }
    }

    /**
     * Records the share as RECEIVED. Null when ABDM delivered the same share twice at once and the
     * other delivery holds the REQUEST-ID (unique in the table): that one answers it.
     */
    private async recordShare(requestId: string, share: ParsedShare, hospitalId: number | null): Promise<number | null> {
        const { patient, counterId, hipId } = share;
        try {
            return await this.store.createShare({
                requestId,
                hipId,
                counterId,
                abhaNumber: patient.abhaNumber,
                abhaAddress: patient.abhaAddress,
                patientName: patient.name,
                userId: null,
                hospitalId,
                tokenNumber: null,
                expiresAt: null,
                status: "RECEIVED",
                matchType: null,
                error: null,
            });
        } catch (error) {
            if (await this.store.findShareByRequestId(requestId).catch(() => null)) return null;
            throw error;
        }
    }

    /**
     * Runs [work] once every earlier call with the same key has finished. Queue tokens are read
     * then written, so each counter allocates one at a time. In-process only: this assumes one
     * backend instance.
     */
    private async withTokenLock<T>(key: string, work: () => Promise<T>): Promise<T> {
        const previous = this.tokenLocks.get(key) ?? Promise.resolve();
        const run = previous.then(work);
        const settled = run.then(() => undefined, () => undefined);
        this.tokenLocks.set(key, settled);
        try {
            return await run;
        } finally {
            if (this.tokenLocks.get(key) === settled) this.tokenLocks.delete(key);
        }
    }

    /** Today's queue entries at the desk's hospital, newest first (a repeat scan is not one). */
    async queue(input: { hospitalId: number; counterId?: string }): Promise<ShareRow[]> {
        return this.store.listShares({
            hospitalId: input.hospitalId,
            since: startOfToday(this.clock()),
            counterId: input.counterId ? assertCounterId(input.counterId) : undefined,
        });
    }

    private async onShare(body: Record<string, unknown>): Promise<void> {
        await this.gateway.call({
            operation: "patient-share/v3/on-share",
            method: "POST",
            host: "gateway",
            path: "/api/hiecm/patient-share/v3/on-share",
            body,
        });
    }
}
