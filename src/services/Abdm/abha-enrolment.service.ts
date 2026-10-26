import { abdmConfig } from "../../config/abdm.config.js";
import { AbdmApiError, abdmGatewayService, abdmNotConfiguredError, type AbdmFile, type AbdmGatewayService } from "./abdm-gateway.service.js";
import { abdmCryptoService, type AbdmCryptoService } from "./abdm-crypto.service.js";
import { AbhaSessionStore, type AbhaEnrolmentSession, type AbhaProfileSummary, type OtpState } from "./abha-session.store.js";

/**
 * ABDM M1, Create ABHA by Aadhaar OTP, for the front desk:
 *   consent -> request/otp (Aadhaar) -> enrol/byAadhaar -> [verify the communication mobile]
 *   -> enrol/suggestion -> enrol/abha-address -> [ABHA card] -> link to the clinic's patient record.
 *
 * An Aadhaar that already holds an ABHA comes back from enrol/byAadhaar with isNew false and
 * that account: the journey carries on with it and nothing new is created.
 */

export const CONSENT_CODE = "abha-enrollment";
export const CONSENT_VERSION = "1.4";
export const OTP_RESEND_COOLDOWN_MS = 60_000;
export const OTP_MAX_RESENDS = 2;
export const RESEND_LIMIT_MESSAGE = "Maximum OTP resend attempts reached. Please try again after 30 mins";
export const AADHAAR_INVALID_MESSAGE = "Aadhaar Number is not valid";

/** Encrypted request fields: when ABDM refuses one, the cached certificate may be stale. */
const ENCRYPTED_FIELDS = new Set(["loginId", "otpValue"]);

export class AbhaJourneyError extends Error {
    readonly status: number;
    readonly kind: string;
    readonly details: Record<string, unknown>;

    constructor(status: number, kind: string, message: string, details: Record<string, unknown> = {}) {
        super(message);
        this.name = "AbhaJourneyError";
        this.status = status;
        this.kind = kind;
        this.details = details;
    }
}

export interface AbhaConsentInput {
    termsAccepted: boolean;
    declarations: {
        aadhaarSharing: boolean;
        otherDocument: boolean;
        linkRecords: boolean;
        shareWithProviders: boolean;
        anonymisedUse: boolean;
    };
    staffConfirmed: boolean;
    beneficiaryConfirmed: boolean;
    beneficiaryName?: string;
    language?: string;
}

export interface NewAbhaConsent {
    consentCode: string;
    consentVersion: string;
    declarations: string;
    staffUserId: string;
    staffName: string | null;
    beneficiaryName: string | null;
    hospitalId: number | null;
    organizationId: number | null;
    agreedAt: Date;
}

export interface LinkedPatient {
    userId: string;
    name: string;
    tokenNumber: string | null;
}

/** What the journey reads and writes in the clinic's own database. */
export interface AbhaEnrolmentStore {
    saveConsent(consent: NewAbhaConsent): Promise<number>;
    updateConsent(consentId: number, changes: { txnId?: string; abhaNumber?: string; patientUserId?: string }): Promise<void>;
    staffName(userId: string): Promise<string | null>;
    findPatientByAbhaNumber(abhaNumber: string): Promise<LinkedPatient | null>;
    patientExists(userId: string): Promise<boolean>;
    linkAbha(userId: string, abhaNumber: string, abhaAddress: string | null): Promise<void>;
}

export interface VerifyOtpResult {
    isNew: boolean;
    message: string;
    abhaNumber: string | null;
    abhaAddress: string | null;
    profile: AbhaProfileSummary;
    mobileVerificationNeeded: boolean;
    communicationMobileLast4: string | null;
    linkedPatient: LinkedPatient | null;
}

const lastFourDigits = (text: string | null | undefined): string | null => {
    const match = (text || "").match(/(\d{4})\D*$/);
    return match ? match[1]! : null;
};

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const textOrNull = (value: unknown): string | null => text(value) || null;

/** DD-MM-YYYY from ABDM's dob, or from its day/month/year fields. */
const toDisplayDate = (profile: Record<string, any>): string | null => {
    const dob = text(profile.dob);
    let match = dob.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (match) return `${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}-${match[3]}`;
    match = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) return `${match[3]}-${match[2]}-${match[1]}`;

    const day = text(String(profile.dayOfBirth ?? ""));
    const month = text(String(profile.monthOfBirth ?? ""));
    const year = text(String(profile.yearOfBirth ?? ""));
    if (/^\d{4}$/.test(year) && /^\d{1,2}$/.test(day) && /^\d{1,2}$/.test(month)) {
        return `${day.padStart(2, "0")}-${month.padStart(2, "0")}-${year}`;
    }
    return null;
};

/** enrol/byAadhaar answers in one of two shapes; both become one summary. */
export const toProfileSummary = (response: Record<string, any>): AbhaProfileSummary => {
    const profile: Record<string, any> = response.ABHAProfile && typeof response.ABHAProfile === "object" ? response.ABHAProfile : response;
    const addresses = Array.isArray(profile.phrAddress)
        ? profile.phrAddress.filter((address: unknown): address is string => typeof address === "string")
        : textOrNull(profile.healthId) ? [text(profile.healthId)] : [];

    return {
        abhaNumber: textOrNull(profile.ABHANumber) ?? textOrNull(profile.healthIdNumber),
        firstName: text(profile.firstName),
        middleName: text(profile.middleName),
        lastName: text(profile.lastName),
        dateOfBirth: toDisplayDate(profile),
        gender: textOrNull(profile.gender),
        mobile: textOrNull(profile.mobile),
        address: textOrNull(profile.address),
        districtName: textOrNull(profile.districtName),
        stateName: textOrNull(profile.stateName),
        pincode: textOrNull(profile.pinCode) ?? textOrNull(profile.pincode),
        abhaAddresses: addresses,
        photo: textOrNull(profile.photo) ?? textOrNull(profile.profilePhoto),
        abhaStatus: textOrNull(profile.abhaStatus) ?? textOrNull(profile.status),
    };
};

export type AbhaAddressRule = "length" | "characters" | "oneDot" | "oneUnderscore" | "edges" | "notMobile";

/**
 * The ABHA address rules functional testing prints beside the field (CRT_ABHA_112): 8 to 18
 * characters including the @sbx or @abdm suffix, letters and digits, at most one dot and one
 * underscore, neither first nor last. A mobile number cannot be an address.
 * Returns the local part (without suffix) and the rules it breaks.
 */
export const checkAbhaAddress = (input: string, suffix: string): { localPart: string; broken: AbhaAddressRule[] } => {
    const localPart = input.trim().replace(/@(sbx|abdm)$/i, "");
    const broken: AbhaAddressRule[] = [];
    const length = localPart.length + suffix.length;
    if (length < 8 || length > 18) broken.push("length");
    if (!/^[A-Za-z0-9._]+$/.test(localPart)) broken.push("characters");
    if ((localPart.match(/\./g) || []).length > 1) broken.push("oneDot");
    if ((localPart.match(/_/g) || []).length > 1) broken.push("oneUnderscore");
    if (/^[._]|[._]$/.test(localPart)) broken.push("edges");
    if (/^[6-9]\d{9}$/.test(localPart)) broken.push("notMobile");
    return { localPart, broken };
};

const assertConsent = (consent: AbhaConsentInput | undefined): void => {
    const d = consent?.declarations;
    const complete = !!consent && consent.termsAccepted === true && !!d &&
        d.aadhaarSharing === true && d.linkRecords === true && d.shareWithProviders === true && d.anonymisedUse === true &&
        consent.staffConfirmed === true && consent.beneficiaryConfirmed === true;
    if (!complete) {
        throw new AbhaJourneyError(400, "consent", "The patient's consent is incomplete. Agree to the terms, tick each declaration and both confirmations before the Aadhaar number is sent.");
    }
    if (d!.otherDocument === true) {
        throw new AbhaJourneyError(400, "consent", "Creating an ABHA with a document other than Aadhaar is not available here yet.");
    }
};

export class AbhaEnrolmentService {
    private readonly store: AbhaEnrolmentStore;
    private readonly gateway: Pick<AbdmGatewayService, "call">;
    private readonly crypto: Pick<AbdmCryptoService, "encrypt" | "invalidate">;
    private readonly clock: () => number;
    private readonly sessions: AbhaSessionStore;

    constructor(
        store: AbhaEnrolmentStore,
        gateway: Pick<AbdmGatewayService, "call"> = abdmGatewayService,
        crypto: Pick<AbdmCryptoService, "encrypt" | "invalidate"> = abdmCryptoService,
        clock: () => number = Date.now,
    ) {
        this.store = store;
        this.gateway = gateway;
        this.crypto = crypto;
        this.clock = clock;
        this.sessions = new AbhaSessionStore(clock);
    }

    /** Records the consent, then sends the Aadhaar OTP. Nothing reaches ABDM before the consent is stored. */
    async requestAadhaarOtp(input: {
        aadhaar: string;
        consent: AbhaConsentInput;
        staffUserId: string;
        hospitalId?: number | null;
        organizationId?: number | null;
    }): Promise<{ sessionId: string; message: string; resendsLeft: number; resendAvailableInSeconds: number }> {
        const aadhaar = String(input.aadhaar ?? "");
        if (!/^\d{12}$/.test(aadhaar)) {
            throw new AbhaJourneyError(400, "validation", AADHAAR_INVALID_MESSAGE, { field: "aadhaar" });
        }
        assertConsent(input.consent);
        if (!abdmConfig.isConfigured) throw abdmNotConfiguredError("enrollment/request/otp");

        const encryptedAadhaar = await this.crypto.encrypt(aadhaar);
        const consentId = await this.store.saveConsent({
            consentCode: CONSENT_CODE,
            consentVersion: CONSENT_VERSION,
            declarations: JSON.stringify({
                termsAccepted: true,
                ...input.consent.declarations,
                staffConfirmed: true,
                beneficiaryConfirmed: true,
                language: input.consent.language || "en",
            }),
            staffUserId: input.staffUserId,
            staffName: await this.store.staffName(input.staffUserId),
            beneficiaryName: text(input.consent.beneficiaryName) || null,
            hospitalId: input.hospitalId ?? null,
            organizationId: input.organizationId ?? null,
            agreedAt: new Date(this.clock()),
        });

        const response = await this.withCertificateCheck(() => this.gateway.call<{ txnId?: string; message?: string }>({
            operation: "enrollment/request/otp (aadhaar)",
            method: "POST",
            path: "/abha/api/v3/enrollment/request/otp",
            body: { scope: ["abha-enrol"], loginHint: "aadhaar", loginId: encryptedAadhaar, otpSystem: "aadhaar" },
        }));
        const txnId = text(response.txnId);
        if (!txnId) {
            throw new AbdmApiError({ status: 502, kind: "unavailable", operation: "enrollment/request/otp", message: "ABDM sent no transaction id with the OTP." });
        }
        await this.store.updateConsent(consentId, { txnId });

        const message = text(response.message) || "OTP sent to the Aadhaar-linked mobile number.";
        const session = this.sessions.create({
            staffUserId: input.staffUserId,
            consentId,
            txnId,
            encryptedAadhaar,
            aadhaarMobileLast4: lastFourDigits(message),
            aadhaarOtp: { sentAt: this.clock(), resends: 0 },
            isNew: null,
            xToken: null,
            xTokenExpiresAt: null,
            profile: null,
            abhaNumber: null,
            abhaAddress: null,
            communicationMobile: null,
        });

        return { sessionId: session.id, message, resendsLeft: OTP_MAX_RESENDS, resendAvailableInSeconds: OTP_RESEND_COOLDOWN_MS / 1000 };
    }

    /** Resends the Aadhaar OTP on the same transaction. */
    async resendAadhaarOtp(sessionId: string, staffUserId: string): Promise<{ message: string; resendsLeft: number; resendAvailableInSeconds: number }> {
        const session = this.session(sessionId, staffUserId);
        if (session.isNew !== null || !session.encryptedAadhaar) {
            throw new AbhaJourneyError(409, "state", "The Aadhaar OTP is already verified.");
        }
        this.assertCanResend(session.aadhaarOtp);

        const response = await this.withCertificateCheck(() => this.gateway.call<{ txnId?: string; message?: string }>({
            operation: "enrollment/request/otp (aadhaar, resend)",
            method: "POST",
            path: "/abha/api/v3/enrollment/request/otp",
            body: { txnId: session.txnId, scope: ["abha-enrol"], loginHint: "aadhaar", loginId: session.encryptedAadhaar, otpSystem: "aadhaar" },
        }));
        session.txnId = text(response.txnId) || session.txnId;
        session.aadhaarOtp = { sentAt: this.clock(), resends: session.aadhaarOtp.resends + 1 };
        const message = text(response.message) || "OTP sent again to the Aadhaar-linked mobile number.";
        session.aadhaarMobileLast4 = lastFourDigits(message) ?? session.aadhaarMobileLast4;

        return { message, resendsLeft: OTP_MAX_RESENDS - session.aadhaarOtp.resends, resendAvailableInSeconds: OTP_RESEND_COOLDOWN_MS / 1000 };
    }

    /**
     * enrol/byAadhaar. A wrong OTP leaves the transaction as it was, so the right OTP can follow.
     * isNew false is an existing ABHA, carried on with exactly like a new one.
     */
    async verifyAadhaarOtp(input: { sessionId: string; staffUserId: string; otp: string; mobile: string }): Promise<VerifyOtpResult> {
        const session = this.session(input.sessionId, input.staffUserId);
        const otp = String(input.otp ?? "");
        const mobile = String(input.mobile ?? "");
        if (!/^\d{6}$/.test(otp)) {
            throw new AbhaJourneyError(400, "validation", "Enter the 6-digit OTP.", { field: "otp" });
        }
        if (!/^\d{10}$/.test(mobile)) {
            throw new AbhaJourneyError(400, "validation", "Enter a valid 10-digit mobile number for ABHA communication.", { field: "mobile" });
        }
        if (session.isNew !== null) {
            throw new AbhaJourneyError(409, "state", "The Aadhaar OTP is already verified.");
        }

        const encryptedOtp = await this.crypto.encrypt(otp);
        const response = await this.withCertificateCheck(() => this.gateway.call<Record<string, any>>({
            operation: "enrollment/enrol/byAadhaar",
            method: "POST",
            path: "/abha/api/v3/enrollment/enrol/byAadhaar",
            body: {
                authData: {
                    authMethods: ["otp"],
                    // ABDM's specification takes this mobile as plain 10 digits.
                    otp: { txnId: session.txnId, otpValue: encryptedOtp, mobile },
                },
                consent: { code: CONSENT_CODE, version: CONSENT_VERSION },
            },
        }));

        const tokens = response.tokens ?? response.jwtResponse ?? (response.token ? { token: response.token } : null);
        const profile = toProfileSummary(response);
        // The flag decides what the desk is told; the message is only a fallback when ABDM omits it.
        const newFlag = response.isNew ?? response.new;
        const isNew = newFlag === undefined ? /created/i.test(text(response.message)) : newFlag === true || newFlag === "true";

        session.isNew = isNew;
        session.txnId = text(response.txnId) || session.txnId;
        session.encryptedAadhaar = null;
        session.xToken = textOrNull(tokens?.token);
        const expiresIn = Number(tokens?.expiresIn);
        session.xTokenExpiresAt = session.xToken ? this.clock() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 1800) * 1000 : null;
        session.profile = profile;
        session.abhaNumber = profile.abhaNumber;
        session.abhaAddress = textOrNull(response.preferredAbhaAddress) ?? profile.abhaAddresses[0] ?? null;

        // A new ABHA whose communication mobile is not the Aadhaar-linked one verifies it next.
        const linkedLast4 = session.aadhaarMobileLast4 ?? lastFourDigits(profile.mobile);
        const mobileVerificationNeeded = isNew && linkedLast4 !== mobile.slice(-4);
        if (mobileVerificationNeeded) {
            session.communicationMobile = { encrypted: await this.crypto.encrypt(mobile), last4: mobile.slice(-4), otp: null, verified: false };
        }

        if (profile.abhaNumber) {
            await this.store.updateConsent(session.consentId, { abhaNumber: profile.abhaNumber });
        }

        return {
            isNew,
            message: text(response.message) || (isNew ? "Account created successfully" : "This account already exist"),
            abhaNumber: session.abhaNumber,
            abhaAddress: session.abhaAddress,
            profile,
            mobileVerificationNeeded,
            communicationMobileLast4: session.communicationMobile?.last4 ?? null,
            linkedPatient: profile.abhaNumber ? await this.store.findPatientByAbhaNumber(profile.abhaNumber) : null,
        };
    }

    /** Sends (or resends) the OTP that verifies the communication mobile. */
    async requestMobileOtp(sessionId: string, staffUserId: string): Promise<{ message: string; resendsLeft: number; resendAvailableInSeconds: number }> {
        const session = this.session(sessionId, staffUserId);
        const mobile = session.communicationMobile;
        if (!mobile) throw new AbhaJourneyError(409, "state", "This ABHA does not need its mobile number verified.");
        if (mobile.verified) throw new AbhaJourneyError(409, "state", "The mobile number is already verified.");
        if (mobile.otp) this.assertCanResend(mobile.otp);

        const response = await this.withCertificateCheck(() => this.gateway.call<{ txnId?: string; message?: string }>({
            operation: "enrollment/request/otp (mobile-verify)",
            method: "POST",
            path: "/abha/api/v3/enrollment/request/otp",
            body: { txnId: session.txnId, scope: ["abha-enrol", "mobile-verify"], loginHint: "mobile", loginId: mobile.encrypted, otpSystem: "abdm" },
        }));
        session.txnId = text(response.txnId) || session.txnId;
        mobile.otp = mobile.otp ? { sentAt: this.clock(), resends: mobile.otp.resends + 1 } : { sentAt: this.clock(), resends: 0 };

        return {
            message: text(response.message) || `OTP sent to the mobile number ending with ${mobile.last4}.`,
            resendsLeft: OTP_MAX_RESENDS - mobile.otp.resends,
            resendAvailableInSeconds: OTP_RESEND_COOLDOWN_MS / 1000,
        };
    }

    async verifyMobileOtp(input: { sessionId: string; staffUserId: string; otp: string }): Promise<{ verified: true; message: string }> {
        const session = this.session(input.sessionId, input.staffUserId);
        const mobile = session.communicationMobile;
        if (!mobile?.otp) throw new AbhaJourneyError(409, "state", "Send the mobile OTP first.");
        if (!/^\d{6}$/.test(String(input.otp ?? ""))) {
            throw new AbhaJourneyError(400, "validation", "Enter the 6-digit OTP.", { field: "otp" });
        }

        const encryptedOtp = await this.crypto.encrypt(String(input.otp));
        const response = await this.withCertificateCheck(() => this.gateway.call<{ txnId?: string; authResult?: string; message?: string }>({
            operation: "enrollment/auth/byAbdm (mobile-verify)",
            method: "POST",
            path: "/abha/api/v3/enrollment/auth/byAbdm",
            body: {
                scope: ["abha-enrol", "mobile-verify"],
                authData: { authMethods: ["otp"], otp: { txnId: session.txnId, otpValue: encryptedOtp } },
            },
        }));
        if (text(response.authResult).toLowerCase() !== "success") {
            throw new AbhaJourneyError(422, "rejected", "ABDM did not verify the mobile OTP.", { abdmMessage: textOrNull(response.message) });
        }
        session.txnId = text(response.txnId) || session.txnId;
        mobile.verified = true;
        return { verified: true, message: text(response.message) || "Mobile number verified." };
    }

    async getAddressSuggestions(sessionId: string, staffUserId: string): Promise<{ suggestions: string[]; suffix: string }> {
        const session = this.verifiedSession(sessionId, staffUserId);
        const response = await this.gateway.call<{ txnId?: string; abhaAddressList?: unknown }>({
            operation: "enrollment/enrol/suggestion",
            method: "GET",
            path: "/abha/api/v3/enrollment/enrol/suggestion",
            headers: { TRANSACTION_ID: session.txnId },
        });
        session.txnId = text(response.txnId) || session.txnId;
        const suggestions = Array.isArray(response.abhaAddressList)
            ? response.abhaAddressList.filter((address): address is string => typeof address === "string")
            : [];
        return { suggestions, suffix: abdmConfig.abhaAddressSuffix };
    }

    async createAbhaAddress(input: { sessionId: string; staffUserId: string; abhaAddress: string }): Promise<{ abhaNumber: string | null; abhaAddress: string }> {
        const session = this.verifiedSession(input.sessionId, input.staffUserId);
        const suffix = abdmConfig.abhaAddressSuffix;
        const { localPart, broken } = checkAbhaAddress(String(input.abhaAddress ?? ""), suffix);
        if (broken.length > 0) {
            throw new AbhaJourneyError(400, "validation", "This ABHA address does not meet the ABHA address rules.", { field: "abhaAddress", broken });
        }

        const response = await this.gateway.call<{ txnId?: string; healthIdNumber?: string; preferredAbhaAddress?: string }>({
            operation: "enrollment/enrol/abha-address",
            method: "POST",
            path: "/abha/api/v3/enrollment/enrol/abha-address",
            body: { txnId: session.txnId, abhaAddress: localPart, preferred: 1 },
        });
        session.txnId = text(response.txnId) || session.txnId;
        session.abhaNumber = textOrNull(response.healthIdNumber) ?? session.abhaNumber;
        session.abhaAddress = textOrNull(response.preferredAbhaAddress) ?? `${localPart}${suffix}`;
        return { abhaNumber: session.abhaNumber, abhaAddress: session.abhaAddress };
    }

    /** The ABHA card image, as ABDM renders it. */
    async getAbhaCard(sessionId: string, staffUserId: string): Promise<{ contentType: string; base64: string }> {
        const session = this.verifiedSession(sessionId, staffUserId);
        if (!session.xToken || (session.xTokenExpiresAt !== null && this.clock() >= session.xTokenExpiresAt)) {
            // Worded without "expired": the frontend's HTTP client reads that word as its own login lapsing.
            throw new AbhaJourneyError(410, "session-ended", "The ABHA session for this card has timed out. Verify the patient again to view the card.");
        }
        const file = await this.gateway.call<AbdmFile>({
            operation: "profile/account/abha-card",
            method: "GET",
            path: "/abha/api/v3/profile/account/abha-card",
            headers: { "X-token": `Bearer ${session.xToken}` },
            binary: true,
        });
        return { contentType: file.contentType, base64: file.data.toString("base64") };
    }

    /**
     * Stores the ABHA number and preferred address on the clinic's patient record. The values
     * come from the verified session, never from the browser. One ABHA number, one patient.
     */
    async linkToPatient(input: { sessionId: string; staffUserId: string; userId: string }): Promise<{ abhaNumber: string; abhaAddress: string | null }> {
        const session = this.verifiedSession(input.sessionId, input.staffUserId);
        const abhaNumber = session.abhaNumber;
        if (!abhaNumber) {
            throw new AbhaJourneyError(409, "state", "ABDM has not returned an ABHA number for this session yet.");
        }
        if (!(await this.store.patientExists(input.userId))) {
            throw new AbhaJourneyError(404, "not-found", "Patient record not found.");
        }

        const holder = await this.store.findPatientByAbhaNumber(abhaNumber);
        if (holder && holder.userId.toLowerCase() !== input.userId.toLowerCase()) {
            throw this.alreadyLinked(holder);
        }

        try {
            await this.store.linkAbha(input.userId, abhaNumber, session.abhaAddress);
        } catch (error: any) {
            // The unique index caught a link made a moment ago by another desk.
            if (/UX_Users_AbhaNumber|duplicate key/i.test(String(error?.message))) {
                const current = await this.store.findPatientByAbhaNumber(abhaNumber);
                throw this.alreadyLinked(current);
            }
            throw error;
        }
        await this.store.updateConsent(session.consentId, { abhaNumber, patientUserId: input.userId });
        return { abhaNumber, abhaAddress: session.abhaAddress };
    }

    private alreadyLinked(holder: LinkedPatient | null): AbhaJourneyError {
        return new AbhaJourneyError(409, "already-linked", "This ABHA number is already linked to another patient record. Open that patient instead of registering again.", {
            linkedPatient: holder,
        });
    }

    private session(sessionId: string, staffUserId: string): AbhaEnrolmentSession {
        const session = this.sessions.get(String(sessionId ?? ""), staffUserId);
        if (!session) {
            throw new AbhaJourneyError(410, "session-ended", "This ABHA session has timed out or was started by another login. Start again.");
        }
        return session;
    }

    private verifiedSession(sessionId: string, staffUserId: string): AbhaEnrolmentSession {
        const session = this.session(sessionId, staffUserId);
        if (session.isNew === null) {
            throw new AbhaJourneyError(409, "state", "Verify the Aadhaar OTP first.");
        }
        return session;
    }

    private assertCanResend(otp: OtpState): void {
        if (otp.resends >= OTP_MAX_RESENDS) {
            throw new AbhaJourneyError(429, "resend-limit", RESEND_LIMIT_MESSAGE);
        }
        const waitMs = otp.sentAt + OTP_RESEND_COOLDOWN_MS - this.clock();
        if (waitMs > 0) {
            throw new AbhaJourneyError(429, "resend-wait", `You can resend the OTP in ${Math.ceil(waitMs / 1000)} seconds.`, {
                retryAfterSeconds: Math.ceil(waitMs / 1000),
            });
        }
    }

    /** A refused encrypted field usually means a stale certificate: drop it so the next try fetches a fresh one. */
    private async withCertificateCheck<T>(call: () => Promise<T>): Promise<T> {
        try {
            return await call();
        } catch (error) {
            if (error instanceof AbdmApiError && error.field && ENCRYPTED_FIELDS.has(error.field)) {
                this.crypto.invalidate();
            }
            throw error;
        }
    }
}
