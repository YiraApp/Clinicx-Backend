import { randomUUID } from "crypto";

/**
 * Server-side state of one ABHA journey at the front desk: creating an ABHA, verifying an existing
 * one, or finding one by mobile. The browser only ever holds the session id: user tokens, txnIds
 * and every ciphertext stay here, bound to the staff member who started the journey, and expire
 * after 30 idle minutes.
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
    /** The whole name when ABDM sends no separate parts. */
    fullName: string;
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
    kycVerified: boolean | null;
}

/** Which ABDM API family issued the user token: the ABHA profile, or the PHR (ABHA address) login. */
export type AbhaTokenKind = "abha" | "phr";

export type AbhaFlow = "create" | "verify" | "find";

/** An OTP login in progress: what was sent, so a resend can repeat it on the same transaction. */
export interface PendingLogin {
    family: AbhaTokenKind;
    requestPath: string;
    requestBody: Record<string, unknown>;
    verifyPath: string;
    verifyScope: string[];
    otp: OtpState;
}

export interface FoundAccount {
    index: number;
    abhaNumber: string;
    name: string;
    gender: string | null;
    authMethods: string[];
}

export interface LoginAccount {
    abhaNumber: string;
    abhaAddress: string | null;
    name: string;
    status: string | null;
}

export interface AbhaSession {
    id: string;
    staffUserId: string;
    flow: AbhaFlow;
    /** The consent recorded before an Aadhaar number went to ABDM: to create an ABHA, or to verify one by Aadhaar. */
    consentId: number | null;
    txnId: string;
    /** The Aadhaar number as ABDM ciphertext, kept only until the OTP verifies: a resend needs it. */
    encryptedAadhaar: string | null;
    /** Last four digits of the Aadhaar-linked mobile, from ABDM's "ending with ******0903". */
    aadhaarMobileLast4: string | null;
    aadhaarOtp: OtpState | null;
    /** Create journey: set once enrol/byAadhaar succeeds. */
    isNew: boolean | null;
    /** True once ABDM has verified the person and a user token is held. */
    verified: boolean;
    tokenKind: AbhaTokenKind;
    xToken: string | null;
    xTokenExpiresAt: number | null;
    /** Short-lived token from a login that returned no refresh token; exchanged at verify/user. */
    tToken: string | null;
    profile: AbhaProfileSummary | null;
    abhaNumber: string | null;
    abhaAddress: string | null;
    /** An ABHA-address login: the address the patient gave, which the record keeps over the preferred one. */
    loginAbhaAddress: string | null;
    /** Create journey: the communication mobile, when it is not the Aadhaar-linked one. */
    communicationMobile: { encrypted: string; last4: string; otp: OtpState | null; verified: boolean } | null;
    login: PendingLogin | null;
    foundAccounts: FoundAccount[] | null;
    loginAccounts: LoginAccount[] | null;
    /** Updating the mobile on a verified ABHA profile. */
    profileMobile: { txnId: string; last4: string; otp: OtpState } | null;
    /**
     * After an ABHA-address login: ABDM updates the profile mobile only with an ABHA-number login's
     * token, so the desk verifies that number too. The OTP login in progress, then its token, used
     * for the mobile update alone (the session stays the address login, its card the PHR card).
     */
    mobileLogin: (PendingLogin & { txnId: string }) | null;
    mobileXToken: string | null;
    mobileXTokenExpiresAt: number | null;
    expiresAt: number;
}

export type NewAbhaSession = Pick<AbhaSession, "staffUserId" | "flow" | "txnId"> & Partial<Omit<AbhaSession, "id" | "expiresAt">>;

export class AbhaSessionStore {
    private readonly sessions = new Map<string, AbhaSession>();
    private readonly clock: () => number;
    private readonly idleMs: number;

    constructor(clock: () => number = Date.now, idleMs: number = 30 * 60_000) {
        this.clock = clock;
        this.idleMs = idleMs;
    }

    create(init: NewAbhaSession): AbhaSession {
        this.sweep();
        const session: AbhaSession = {
            consentId: null,
            encryptedAadhaar: null,
            aadhaarMobileLast4: null,
            aadhaarOtp: null,
            isNew: null,
            verified: false,
            tokenKind: "abha",
            xToken: null,
            xTokenExpiresAt: null,
            tToken: null,
            profile: null,
            abhaNumber: null,
            abhaAddress: null,
            loginAbhaAddress: null,
            communicationMobile: null,
            login: null,
            foundAccounts: null,
            loginAccounts: null,
            profileMobile: null,
            mobileLogin: null,
            mobileXToken: null,
            mobileXTokenExpiresAt: null,
            ...init,
            id: randomUUID(),
            expiresAt: this.clock() + this.idleMs,
        };
        this.sessions.set(session.id, session);
        return session;
    }

    /** The session, if it exists, has not expired and belongs to [staffUserId]. Using it extends it. */
    get(id: string, staffUserId: string): AbhaSession | null {
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
