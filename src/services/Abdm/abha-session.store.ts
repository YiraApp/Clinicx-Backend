import { randomUUID } from "crypto";

/**
 * Server-side state of one ABHA enrolment at the front desk. The browser only ever holds the
 * session id: the user token, the txnId and every ciphertext stay here, bound to the staff
 * member who started the journey, and expire after 30 idle minutes.
 *
 * Kept in memory, so a journey must stay on the instance that started it (one App Service
 * instance, or ARR affinity, which App Service enables by default).
 */

export interface OtpState {
    sentAt: number;
    resends: number;
}

export interface AbhaProfileSummary {
    abhaNumber: string | null;
    firstName: string;
    middleName: string;
    lastName: string;
    /** DD-MM-YYYY */
    dateOfBirth: string | null;
    /** As ABDM sends it: M, F, O, T, U */
    gender: string | null;
    /** Masked by ABDM, for example ******0903 */
    mobile: string | null;
    address: string | null;
    districtName: string | null;
    stateName: string | null;
    pincode: string | null;
    abhaAddresses: string[];
    /** Base64 photo, as ABDM sends it */
    photo: string | null;
    abhaStatus: string | null;
}

export interface AbhaEnrolmentSession {
    id: string;
    staffUserId: string;
    consentId: number;
    txnId: string;
    /** The Aadhaar number as ABDM ciphertext, kept only until the OTP verifies: a resend needs it. */
    encryptedAadhaar: string | null;
    /** Last four digits of the Aadhaar-linked mobile, from ABDM's "ending with ******0903". */
    aadhaarMobileLast4: string | null;
    aadhaarOtp: OtpState;
    /** Set once enrol/byAadhaar succeeds. */
    isNew: boolean | null;
    xToken: string | null;
    xTokenExpiresAt: number | null;
    profile: AbhaProfileSummary | null;
    abhaNumber: string | null;
    abhaAddress: string | null;
    /** The communication mobile, when it is not the Aadhaar-linked one and must be verified. */
    communicationMobile: { encrypted: string; last4: string; otp: OtpState | null; verified: boolean } | null;
    expiresAt: number;
}

export type NewAbhaEnrolmentSession = Omit<AbhaEnrolmentSession, "id" | "expiresAt">;

export class AbhaSessionStore {
    private readonly sessions = new Map<string, AbhaEnrolmentSession>();
    private readonly clock: () => number;
    private readonly idleMs: number;

    constructor(clock: () => number = Date.now, idleMs: number = 30 * 60_000) {
        this.clock = clock;
        this.idleMs = idleMs;
    }

    create(init: NewAbhaEnrolmentSession): AbhaEnrolmentSession {
        this.sweep();
        const session: AbhaEnrolmentSession = { ...init, id: randomUUID(), expiresAt: this.clock() + this.idleMs };
        this.sessions.set(session.id, session);
        return session;
    }

    /** The session, if it exists, has not expired and belongs to [staffUserId]. Using it extends it. */
    get(id: string, staffUserId: string): AbhaEnrolmentSession | null {
        const session = this.sessions.get(id);
        if (!session) return null;
        if (this.clock() >= session.expiresAt) {
            this.sessions.delete(id);
            return null;
        }
        if (session.staffUserId.toLowerCase() !== staffUserId.toLowerCase()) return null;
        session.expiresAt = this.clock() + this.idleMs;
        return session;
    }

    private sweep(): void {
        const now = this.clock();
        for (const [id, session] of this.sessions) {
            if (now >= session.expiresAt) this.sessions.delete(id);
        }
    }
}
