import { abdmConfig } from "../../config/abdm.config.js";
import { abdmGatewayService, type AbdmGatewayService } from "./abdm-gateway.service.js";
import { AbhaJourneyError, text, textOrNull } from "./abha-enrolment.service.js";

/**
 * ABDM Scan and Share at the counter (SHARE_PATIENT_PROFILE_701/702): the patient scans the
 * counter's QR code in their ABHA app and agrees to share; ABDM posts their profile to
 * /api/v3/hip/patient/share. We answer 200 at once, then register or match the patient with
 * nothing typed at the desk, give them a queue token, and send it back on on-share.
 *
 * Matching: the ABHA number first, then name, mobile, gender and year of birth. Exactly one match
 * reuses that patient; none creates one; more than one is left for the desk (REVIEW), because
 * guessing would merge two people. A repeat scan at the same counter while its token is still
 * valid keeps that token; another counter gets its own.
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
    counterId: string;
    patient: SharedPatient;
}

export type ShareStatus = "RECEIVED" | "REGISTERED" | "REVIEW" | "ACKNOWLEDGED" | "FAILED";
export type ShareMatch = "NEW" | "ABHA_NUMBER" | "DEMOGRAPHIC" | "AMBIGUOUS";

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

/** What Scan and Share reads and writes in the clinic database. */
export interface AbhaShareStore {
    findShareByRequestId(requestId: string): Promise<ShareRow | null>;
    createShare(row: Omit<ShareRow, "id" | "createdAt">): Promise<number>;
    updateShare(id: number, changes: Partial<Omit<ShareRow, "id" | "createdAt">>): Promise<void>;
    /** The newest share for this patient at this counter whose token is still valid. */
    findActiveShare(input: { userId: string; hospitalId: number; counterId: string; now: Date }): Promise<ShareRow | null>;
    /** The highest numeric token issued today at this counter, or 0. */
    maxTokenToday(input: { hospitalId: number; counterId: string; since: Date }): Promise<number>;
    listShares(input: { hospitalId: number; since: Date; counterId?: string }): Promise<ShareRow[]>;
    findPatientIdByAbhaNumber(abhaNumber: string): Promise<string | null>;
    /** Live patients matching name, mobile, gender and year of birth, who hold no other ABHA number. */
    findPatientIdsByDemographics(patient: SharedPatient): Promise<string[]>;
    /** Creates the patient (user, address, patient role and registration at [hospitalId]). Returns the user id. */
    createPatient(patient: SharedPatient, hospitalId: number): Promise<string>;
    /** Records the ABHA on an existing patient and makes sure they are registered at [hospitalId]. */
    updatePatientAbha(userId: string, patient: SharedPatient, hospitalId: number): Promise<void>;
}

const GENDERS: Record<string, string> = { M: "Male", F: "Female", O: "Other", T: "Other", D: "Other", U: "Other" };
const COUNTER_ID = /^[A-Za-z0-9]{1,20}$/;

const startOfToday = (now: number): Date => {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    return day;
};

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

    constructor(store: AbhaShareStore, gateway: Pick<AbdmGatewayService, "call"> = abdmGatewayService, clock: () => number = Date.now) {
        this.store = store;
        this.gateway = gateway;
        this.clock = clock;
    }

    /** Validates ABDM's share body before we answer it. Throws an AbhaJourneyError for a share we must refuse. */
    parse(hipIdHeader: unknown, body: any): ParsedShare {
        if (body?.intent !== "PROFILE_SHARE") {
            throw new AbhaJourneyError(400, "validation", "Only PROFILE_SHARE is handled here.");
        }
        const hipId = text(body?.metaData?.hipId) || text(hipIdHeader);
        if (!hipId || !abdmConfig.hipIds.includes(hipId) || (text(hipIdHeader) && text(hipIdHeader) !== hipId)) {
            throw new AbhaJourneyError(403, "validation", "This share is not for a HIP this system serves.");
        }
        const counterId = text(body?.metaData?.context);
        if (!counterId) {
            throw new AbhaJourneyError(400, "validation", "The share carries no counter id (metaData.context).");
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
            counterId,
            patient: {
                abhaNumber: textOrNull(p.abhaNumber),
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
     * A REQUEST-ID already seen is a retry of the same share and is not processed twice.
     */
    async process(requestId: string, share: ParsedShare): Promise<void> {
        if (await this.store.findShareByRequestId(requestId)) {
            console.log(`[ABDM] Share REQUEST-ID=${requestId} already handled; ignoring the retry`);
            return;
        }
        const { patient, counterId, hipId } = share;
        const hospitalId = abdmConfig.hipHospitalId;
        const shareId = await this.store.createShare({
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

        try {
            if (!hospitalId) {
                throw new Error("ABDM_HIP_HOSPITAL_ID is not set, so the share has no hospital to register the patient at.");
            }

            let userId: string | null = null;
            let matchType: ShareMatch;
            const byAbha = patient.abhaNumber ? await this.store.findPatientIdByAbhaNumber(patient.abhaNumber) : null;
            if (byAbha) {
                userId = byAbha;
                matchType = "ABHA_NUMBER";
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

            // Same patient, same counter, token still valid: no new queue entry.
            const now = this.clock();
            const active = userId ? await this.store.findActiveShare({ userId, hospitalId, counterId, now: new Date(now) }) : null;
            const tokenNumber = active?.tokenNumber
                ?? String((await this.store.maxTokenToday({ hospitalId, counterId, since: startOfToday(now) })) + 1);
            const expiresAt = active?.expiresAt ?? new Date(now + abdmConfig.shareTokenExpiry * 60_000);

            await this.store.updateShare(shareId, {
                userId,
                matchType,
                tokenNumber,
                expiresAt,
                status: matchType === "AMBIGUOUS" ? "REVIEW" : "REGISTERED",
            });

            await this.onShare({
                acknowledgement: {
                    status: "SUCCESS",
                    abhaAddress: patient.abhaAddress,
                    profile: { context: counterId, tokenNumber, expiry: abdmConfig.shareTokenExpiry },
                },
                response: { requestId },
            });
            if (matchType !== "AMBIGUOUS") {
                await this.store.updateShare(shareId, { status: "ACKNOWLEDGED" });
            }
            console.log(`[ABDM] Share REQUEST-ID=${requestId} counter=${counterId} match=${matchType} token=${tokenNumber}`);
        } catch (error: any) {
            const reason = String(error?.message || error).slice(0, 500);
            console.error(`[ABDM] Share REQUEST-ID=${requestId} failed: ${reason}`);
            await this.store.updateShare(shareId, { status: "FAILED", error: reason }).catch(() => undefined);
            await this.onShare({
                acknowledgement: { status: "FAILED", abhaAddress: patient.abhaAddress },
                error: { code: "ABDM-9999", message: "The facility could not register this share. Please ask at the counter." },
                response: { requestId },
            }).catch((ackError: any) => console.error(`[ABDM] on-share for REQUEST-ID=${requestId} failed too: ${ackError?.message}`));
        }
    }

    /** Today's shares at the desk's hospital, newest first. */
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
