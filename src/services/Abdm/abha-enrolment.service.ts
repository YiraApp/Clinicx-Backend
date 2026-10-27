import { abdmConfig } from "../../config/abdm.config.js";
import { AbdmApiError, abdmGatewayService, abdmNotConfiguredError, type AbdmFile, type AbdmGatewayService } from "./abdm-gateway.service.js";
import { abdmCryptoService, type AbdmCryptoService } from "./abdm-crypto.service.js";
import { AbhaSessionStore, type AbhaSession, type AbhaProfileSummary, type OtpState } from "./abha-session.store.js";

/**
 * ABDM M1, Create ABHA by Aadhaar OTP, for the front desk:
 *   consent -> request/otp (Aadhaar) -> enrol/byAadhaar -> [verify the communication mobile]
 *   -> enrol/suggestion -> enrol/abha-address -> [ABHA card] -> link to the clinic's patient record.
 *
 * An Aadhaar that already holds an ABHA comes back from enrol/byAadhaar with isNew false and
 * that account: the journey carries on with it and nothing new is created.
 *
 * The ABHA card and the link to a patient record serve every journey that ends verified
 * (create here, verify and find in abha-login.service), so they live here too.
 */

export const CONSENT_CODE = "abha-enrollment";
export const CONSENT_VERSION = "1.4";
export const OTP_RESEND_COOLDOWN_MS = 60_000;
export const OTP_MAX_RESENDS = 2;
export const RESEND_LIMIT_MESSAGE = "Maximum OTP resend attempts reached. Please try again after 30 mins";
export const AADHAAR_INVALID_MESSAGE = "Aadhaar Number is not valid";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Encrypted request fields: when ABDM refuses one, the cached certificate may be stale. */
const ENCRYPTED_FIELDS = new Set(["loginId", "otpValue", "mobile"]);

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
    /** The live patient holding any of these ABHA addresses (lower case). */
    findPatientByAbhaAddresses(abhaAddresses: string[]): Promise<LinkedPatient | null>;
    /** A live user record: the ABHA number and every ABHA address it holds, and whether it is registered as a patient anywhere. */
    getPatient(userId: string): Promise<{ abhaNumber: string | null; abhaAddresses: string[]; isPatient: boolean } | null>;
    /**
     * Records the ABHA on the user, and on their registration at [hospitalId] when one is given.
     * Adds [abhaAddresses] to the ones the user already holds; a null number or address keeps the stored one.
     */
    linkAbha(userId: string, abha: AbhaToLink, hospitalId: number | null): Promise<void>;
}

/** What a verified session links to a patient: an ABHA number, an address, or both. */
export interface AbhaToLink {
    abhaNumber: string | null;
    /** The address the record shows: the preferred one, or the one the patient logged in with. */
    abhaAddress: string | null;
    /** Every address ABDM listed for this ABHA, lower case, [abhaAddress] among them. */
    abhaAddresses: string[];
}

/** Every ABHA address the session knows for the person, lower case, the one it keeps first. */
export const sessionAbhaAddresses = (session: Pick<AbhaSession, "abhaAddress" | "profile">): string[] => {
    const addresses: string[] = [];
    for (const value of [session.abhaAddress, ...(session.profile?.abhaAddresses ?? [])]) {
        const address = text(value).toLowerCase();
        if (address && !addresses.includes(address)) addresses.push(address);
    }
    return addresses;
};

/**
 * The patient already holding this ABHA: by its number, else by any of its addresses, which is
 * the only key an address without an ABHA number has.
 */
export const findLinkedPatient = async (
    store: Pick<AbhaEnrolmentStore, "findPatientByAbhaNumber" | "findPatientByAbhaAddresses">,
    abhaNumber: string | null,
    abhaAddresses: string[],
): Promise<LinkedPatient | null> => {
    try {
        const byNumber = abhaNumber ? await store.findPatientByAbhaNumber(abhaNumber) : null;
        return byNumber ?? (abhaAddresses.length > 0 ? await store.findPatientByAbhaAddresses(abhaAddresses) : null);
    } catch (error: any) {
        console.error("[ABDM] Could not check for a patient already holding this ABHA:", error?.message);
        return null;
    }
};

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

export const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
export const textOrNull = (value: unknown): string | null => text(value) || null;

/** One rule for every OTP in M1: resend after 60 seconds, at most twice. */
export const assertCanResend = (otp: OtpState, now: number): void => {
    if (otp.resends >= OTP_MAX_RESENDS) {
        throw new AbhaJourneyError(429, "resend-limit", RESEND_LIMIT_MESSAGE);
    }
    const waitMs = otp.sentAt + OTP_RESEND_COOLDOWN_MS - now;
    if (waitMs > 0) {
        throw new AbhaJourneyError(429, "resend-wait", `You can resend the OTP in ${Math.ceil(waitMs / 1000)} seconds.`, {
            retryAfterSeconds: Math.ceil(waitMs / 1000),
        });
    }
};

/** A refused encrypted field usually means a stale certificate: drop it so the next try fetches a fresh one. */
export const withCertificateCheck = async <T>(crypto: Pick<AbdmCryptoService, "invalidate">, call: () => Promise<T>): Promise<T> => {
    try {
        return await call();
    } catch (error) {
        if (error instanceof AbdmApiError && error.field && ENCRYPTED_FIELDS.has(error.field)) {
            crypto.invalidate();
        }
        throw error;
    }
};

/** DD-MM-YYYY from ABDM's dob or dateOfBirth, or from its day/month/year fields. */
const toDisplayDate = (profile: Record<string, any>): string | null => {
    const dob = text(profile.dob) || text(profile.dateOfBirth);
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

/**
 * One summary from the profile shapes ABDM answers with: enrol/byAadhaar (ABHAProfile, or the
 * older healthIdNumber shape), GET profile/account, and the PHR abha-profile of an address login.
 */
export const toProfileSummary = (response: Record<string, any>): AbhaProfileSummary => {
    const profile: Record<string, any> = response.ABHAProfile && typeof response.ABHAProfile === "object" ? response.ABHAProfile : response;
    const addresses: string[] = [];
    const addAddress = (value: unknown) => {
        const address = text(value);
        if (address && !addresses.includes(address)) addresses.push(address);
    };
    // The preferred address first: the record shows it, unless the patient logged in with another.
    addAddress(profile.preferredAbhaAddress);
    addAddress(profile.abhaAddress);
    if (Array.isArray(profile.phrAddress)) profile.phrAddress.forEach(addAddress);
    addAddress(profile.healthId);

    const kycStatus = text(profile.kycStatus) || text(profile.verificationStatus);
    return {
        abhaNumber: textOrNull(profile.ABHANumber) ?? textOrNull(profile.healthIdNumber) ?? textOrNull(profile.abhaNumber),
        firstName: text(profile.firstName),
        middleName: text(profile.middleName),
        lastName: text(profile.lastName),
        fullName: text(profile.name) || text(profile.fullName),
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
        kycVerified: typeof profile.kycVerified === "boolean" ? profile.kycVerified
            : profile.kycVerified === "true" ? true
            : kycStatus ? kycStatus.toUpperCase() === "VERIFIED" : null,
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
    /** Journeys with an Aadhaar OTP resend on its way: the resend count is written only once ABDM answers. */
    private readonly resending = new Set<string>();

    constructor(
        store: AbhaEnrolmentStore,
        gateway: Pick<AbdmGatewayService, "call"> = abdmGatewayService,
        crypto: Pick<AbdmCryptoService, "encrypt" | "invalidate"> = abdmCryptoService,
        clock: () => number = Date.now,
        sessions: AbhaSessionStore = new AbhaSessionStore(clock),
    ) {
        this.store = store;
        this.gateway = gateway;
        this.crypto = crypto;
        this.clock = clock;
        this.sessions = sessions;
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
            // Only the known declarations, as booleans: nothing else from the request reaches the record.
            declarations: JSON.stringify({
                termsAccepted: true,
                aadhaarSharing: input.consent.declarations.aadhaarSharing === true,
                otherDocument: input.consent.declarations.otherDocument === true,
                linkRecords: input.consent.declarations.linkRecords === true,
                shareWithProviders: input.consent.declarations.shareWithProviders === true,
                anonymisedUse: input.consent.declarations.anonymisedUse === true,
                staffConfirmed: true,
                beneficiaryConfirmed: true,
                language: /^[a-z]{2}$/.test(String(input.consent.language ?? "")) ? input.consent.language : "en",
            }),
            staffUserId: input.staffUserId,
            staffName: await this.store.staffName(input.staffUserId),
            beneficiaryName: text(input.consent.beneficiaryName) || null,
            hospitalId: input.hospitalId ?? null,
            organizationId: input.organizationId ?? null,
            agreedAt: new Date(this.clock()),
        });

        const response = await withCertificateCheck(this.crypto, () => this.gateway.call<{ txnId?: string; message?: string }>({
            operation: "enrollment/request/otp (aadhaar)",
            method: "POST",
            path: "/abha/api/v3/enrollment/request/otp",
            body: { scope: ["abha-enrol"], loginHint: "aadhaar", loginId: encryptedAadhaar, otpSystem: "aadhaar" },
        }));
        const txnId = text(response.txnId);
        if (!txnId) {
            throw new AbdmApiError({ status: 502, kind: "unavailable", operation: "enrollment/request/otp", message: "ABDM sent no transaction id with the OTP." });
        }
        // The OTP is on its way: the consent row already says who agreed and when, the txnId is a convenience.
        await this.store.updateConsent(consentId, { txnId }).catch((error: any) =>
            console.error("[ABDM] Could not record the transaction on the consent:", error?.message));

        const message = text(response.message) || "OTP sent to the Aadhaar-linked mobile number.";
        const session = this.sessions.create({
            staffUserId: input.staffUserId,
            flow: "create",
            consentId,
            txnId,
            encryptedAadhaar,
            aadhaarMobileLast4: lastFourDigits(message),
            aadhaarOtp: { sentAt: this.clock(), resends: 0 },
        });

        return { sessionId: session.id, message, resendsLeft: OTP_MAX_RESENDS, resendAvailableInSeconds: OTP_RESEND_COOLDOWN_MS / 1000 };
    }

    /**
     * Resends the Aadhaar OTP on the same transaction, as the ABHA specification says. ABDM's
     * enrolment service can refuse that transaction ({"txnId": "Invalid Transaction Id"}, the sandbox
     * on 2026-10-27): the OTP then goes out once on a fresh request, whose transaction the journey
     * takes over. Either way it is one resend.
     */
    async resendAadhaarOtp(sessionId: string, staffUserId: string): Promise<{ message: string; resendsLeft: number; resendAvailableInSeconds: number }> {
        const session = this.session(sessionId, staffUserId);
        const aadhaarOtp = session.aadhaarOtp;
        if (session.flow !== "create" || session.verified || !session.encryptedAadhaar || !aadhaarOtp) {
            throw new AbhaJourneyError(409, "state", "The Aadhaar OTP is already verified.");
        }
        assertCanResend(aadhaarOtp, this.clock());
        if (this.resending.has(session.id)) {
            throw new AbhaJourneyError(409, "state", "The OTP is already being sent again.");
        }
        this.resending.add(session.id);

        try {
            const requestOtp = (txnId: string | null) => withCertificateCheck(this.crypto, () => this.gateway.call<{ txnId?: string; message?: string }>({
                operation: txnId ? "enrollment/request/otp (aadhaar, resend)" : "enrollment/request/otp (aadhaar, resend on a new transaction)",
                method: "POST",
                path: "/abha/api/v3/enrollment/request/otp",
                body: { ...(txnId ? { txnId } : {}), scope: ["abha-enrol"], loginHint: "aadhaar", loginId: session.encryptedAadhaar, otpSystem: "aadhaar" },
            }));
            let response: { txnId?: string; message?: string };
            try {
                response = await requestOtp(session.txnId);
            } catch (error) {
                if (!(error instanceof AbdmApiError && error.kind === "rejected" && error.field === "txnId")) throw error;
                console.warn(`[ABDM] Aadhaar OTP resend: ABDM refused the transaction (${error.message}, REQUEST-ID=${error.requestId ?? "-"}); sending it on a new one`);
                response = await requestOtp(null);
                const txnId = text(response.txnId);
                if (!txnId) {
                    throw new AbdmApiError({ status: 502, kind: "unavailable", operation: "enrollment/request/otp", message: "ABDM sent no transaction id with the OTP." });
                }
                if (session.consentId !== null) {
                    await this.store.updateConsent(session.consentId, { txnId }).catch((updateError: any) =>
                        console.error("[ABDM] Could not record the new transaction on the consent:", updateError?.message));
                }
            }
            session.txnId = text(response.txnId) || session.txnId;
            session.aadhaarOtp = { sentAt: this.clock(), resends: aadhaarOtp.resends + 1 };
            const message = text(response.message) || "OTP sent again to the Aadhaar-linked mobile number.";
            session.aadhaarMobileLast4 = lastFourDigits(message) ?? session.aadhaarMobileLast4;

            return { message, resendsLeft: OTP_MAX_RESENDS - session.aadhaarOtp.resends, resendAvailableInSeconds: OTP_RESEND_COOLDOWN_MS / 1000 };
        } finally {
            this.resending.delete(session.id);
        }
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
        if (session.flow !== "create" || session.verified) {
            throw new AbhaJourneyError(409, "state", "The Aadhaar OTP is already verified.");
        }

        const encryptedOtp = await this.crypto.encrypt(otp);
        const response = await withCertificateCheck(this.crypto, () => this.gateway.call<Record<string, any>>({
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

        // A new ABHA whose communication mobile is not the Aadhaar-linked one verifies it next.
        // Everything that can still fail runs before ABDM's answer is committed to the session,
        // so a failure here can be retried instead of stranding an ABHA that now exists.
        const linkedLast4 = session.aadhaarMobileLast4 ?? lastFourDigits(profile.mobile);
        const mobileVerificationNeeded = isNew && linkedLast4 !== mobile.slice(-4);
        const encryptedMobile = mobileVerificationNeeded ? await this.crypto.encrypt(mobile) : null;
        const linkedPatient = await findLinkedPatient(this.store, profile.abhaNumber, sessionAbhaAddresses({ abhaAddress: null, profile }));

        session.isNew = isNew;
        session.verified = true;
        session.tokenKind = "abha";
        session.txnId = text(response.txnId) || session.txnId;
        session.encryptedAadhaar = null;
        session.xToken = textOrNull(tokens?.token);
        const expiresIn = Number(tokens?.expiresIn);
        session.xTokenExpiresAt = session.xToken ? this.clock() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 1800) * 1000 : null;
        session.profile = profile;
        session.abhaNumber = profile.abhaNumber;
        session.abhaAddress = textOrNull(response.preferredAbhaAddress) ?? profile.abhaAddresses[0] ?? null;
        if (encryptedMobile) {
            session.communicationMobile = { encrypted: encryptedMobile, last4: mobile.slice(-4), otp: null, verified: false };
        }

        if (profile.abhaNumber && session.consentId !== null) {
            // The consent row already holds who agreed and when; the ABHA number on it is a convenience.
            await this.store.updateConsent(session.consentId, { abhaNumber: profile.abhaNumber }).catch((error: any) =>
                console.error("[ABDM] Could not record the ABHA number on the consent:", error?.message));
        }

        return {
            isNew,
            message: text(response.message) || (isNew ? "Account created successfully" : "This account already exist"),
            abhaNumber: session.abhaNumber,
            abhaAddress: session.abhaAddress,
            profile,
            mobileVerificationNeeded,
            communicationMobileLast4: session.communicationMobile?.last4 ?? null,
            linkedPatient,
        };
    }

    /** Sends (or resends) the OTP that verifies the communication mobile. */
    async requestMobileOtp(sessionId: string, staffUserId: string): Promise<{ message: string; resendsLeft: number; resendAvailableInSeconds: number }> {
        const session = this.session(sessionId, staffUserId);
        const mobile = session.communicationMobile;
        if (!mobile) throw new AbhaJourneyError(409, "state", "This ABHA does not need its mobile number verified.");
        if (mobile.verified) throw new AbhaJourneyError(409, "state", "The mobile number is already verified.");
        if (mobile.otp) assertCanResend(mobile.otp, this.clock());

        const response = await withCertificateCheck(this.crypto, () => this.gateway.call<{ txnId?: string; message?: string }>({
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
        const response = await withCertificateCheck(this.crypto, () => this.gateway.call<{ txnId?: string; authResult?: string; message?: string }>({
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
        // The new address is the preferred one now; the account's earlier addresses stay its too.
        if (session.profile) {
            session.profile.abhaAddresses = [session.abhaAddress, ...session.profile.abhaAddresses.filter((address) => address.toLowerCase() !== session.abhaAddress!.toLowerCase())];
        }
        return { abhaNumber: session.abhaNumber, abhaAddress: session.abhaAddress };
    }

    /** The ABHA card image, as ABDM renders it. */
    async getAbhaCard(sessionId: string, staffUserId: string): Promise<{ contentType: string; base64: string }> {
        const session = this.verifiedSession(sessionId, staffUserId);
        if (!session.xToken || (session.xTokenExpiresAt !== null && this.clock() >= session.xTokenExpiresAt)) {
            // Worded without "expired": the frontend's HTTP client reads that word as its own login lapsing.
            throw new AbhaJourneyError(410, "session-ended", "The ABHA session for this card has timed out. Verify the patient again to view the card.");
        }
        // An ABHA-address login holds a PHR token, which reads the PHR card instead.
        const phr = session.tokenKind === "phr";
        const file = await this.gateway.call<AbdmFile>({
            operation: phr ? "phr/web/login/profile/abha/phr-card" : "profile/account/abha-card",
            method: "GET",
            path: phr ? "/abha/api/v3/phr/web/login/profile/abha/phr-card" : "/abha/api/v3/profile/account/abha-card",
            headers: { "X-token": `Bearer ${session.xToken}` },
            binary: true,
        });
        return { contentType: file.contentType, base64: file.data.toString("base64") };
    }

    /**
     * Stores the ABHA number and every ABHA address on the clinic's patient record. The values
     * come from the verified session, never from the browser. One ABHA, one patient: an ABHA
     * address without an ABHA number (a non-KYC address) links by its address alone.
     */
    async linkToPatient(input: { sessionId: string; staffUserId: string; userId: string; hospitalId?: number | null }): Promise<{ abhaNumber: string | null; abhaAddress: string | null }> {
        const session = this.verifiedSession(input.sessionId, input.staffUserId);
        const abhaNumber = session.abhaNumber;
        const abhaAddresses = sessionAbhaAddresses(session);
        if (!abhaNumber && abhaAddresses.length === 0) {
            throw new AbhaJourneyError(409, "state", "ABDM has not returned an ABHA number or ABHA address for this session yet.");
        }
        if (!GUID.test(input.userId)) {
            throw new AbhaJourneyError(404, "not-found", "Patient record not found.");
        }
        const patient = await this.store.getPatient(input.userId);
        if (!patient) {
            throw new AbhaJourneyError(404, "not-found", "Patient record not found.");
        }
        if (!patient.isPatient) {
            throw new AbhaJourneyError(409, "not-a-patient", "This record is not registered as a patient, so an ABHA can't be linked to it.");
        }
        // Never overwrite one ABHA with another: that is a different person, or a decision for ABDM.
        if (patient.abhaNumber && abhaNumber && patient.abhaNumber !== abhaNumber) {
            throw new AbhaJourneyError(409, "different-abha", "This patient record already holds a different ABHA number. Check you have the right patient; the ABHA was not linked.");
        }
        // Without an ABHA number on both sides, only a shared address shows it is the same ABHA.
        const recordHoldsAbha = !!patient.abhaNumber || patient.abhaAddresses.length > 0;
        const sharesAddress = patient.abhaAddresses.some((address) => abhaAddresses.includes(address.toLowerCase()));
        if ((!patient.abhaNumber || !abhaNumber) && recordHoldsAbha && !sharesAddress) {
            throw new AbhaJourneyError(409, "different-abha", "This patient record already holds a different ABHA. Check you have the right patient; the ABHA was not linked.");
        }

        const holder = await this.holderOf(abhaNumber, abhaAddresses);
        if (holder && holder.userId.toLowerCase() !== input.userId.toLowerCase()) {
            throw this.alreadyLinked(holder);
        }

        const abhaAddress = session.abhaAddress ? session.abhaAddress.toLowerCase() : abhaAddresses[0] ?? null;
        try {
            await this.store.linkAbha(input.userId, { abhaNumber, abhaAddress, abhaAddresses }, input.hospitalId ?? null);
        } catch (error: any) {
            // A unique index caught a link made a moment ago by another desk.
            if (/UX_Users_AbhaNumber|UX_UserAbhaAddresses_Address|duplicate key/i.test(String(error?.message))) {
                throw this.alreadyLinked(await this.holderOf(abhaNumber, abhaAddresses));
            }
            throw error;
        }
        if (session.consentId !== null) {
            await this.store.updateConsent(session.consentId, { ...(abhaNumber ? { abhaNumber } : {}), patientUserId: input.userId });
        }
        return { abhaNumber, abhaAddress };
    }

    private async holderOf(abhaNumber: string | null, abhaAddresses: string[]): Promise<LinkedPatient | null> {
        const byNumber = abhaNumber ? await this.store.findPatientByAbhaNumber(abhaNumber) : null;
        return byNumber ?? (abhaAddresses.length > 0 ? await this.store.findPatientByAbhaAddresses(abhaAddresses) : null);
    }

    private alreadyLinked(holder: LinkedPatient | null): AbhaJourneyError {
        return new AbhaJourneyError(409, "already-linked", "This ABHA number is already linked to another patient record. Open that patient instead of registering again.", {
            linkedPatient: holder,
        });
    }

    private session(sessionId: string, staffUserId: string): AbhaSession {
        return requireSession(this.sessions, sessionId, staffUserId);
    }

    private verifiedSession(sessionId: string, staffUserId: string): AbhaSession {
        const session = this.session(sessionId, staffUserId);
        if (!session.verified) {
            throw new AbhaJourneyError(409, "state", "Verify the patient's OTP first.");
        }
        return session;
    }
}

/** The journey [sessionId] names, if it is still open and was started by [staffUserId]. */
export const requireSession = (sessions: AbhaSessionStore, sessionId: string, staffUserId: string): AbhaSession => {
    const session = sessions.get(String(sessionId ?? ""), staffUserId);
    if (!session) {
        // Worded without "expired": the frontend's HTTP client reads that word as its own login lapsing.
        throw new AbhaJourneyError(410, "session-ended", "This ABHA session has timed out or was started by another login. Start again.");
    }
    return session;
};
