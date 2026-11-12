import { abdmConfig } from "../../config/abdm.config.js";
import { AbdmApiError, abdmGatewayService, abdmNotConfiguredError, type AbdmFile, type AbdmGatewayService } from "./abdm-gateway.service.js";
import { abdmCryptoService, type AbdmCryptoService } from "./abdm-crypto.service.js";
import { AbhaSessionStore, MOBILE_CHANGE_LIMIT, mobileKey, type AbhaSession, type AbhaProfileSummary, type OtpState } from "./abha-session.store.js";

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
    /** A new ABHA whose communication mobile is not the Aadhaar-linked one: ABDM verifies it by OTP next. */
    mobileVerificationNeeded: boolean;
    /**
     * An existing ABHA (isNew false) whose own mobile is not the communication mobile: ABDM keeps the
     * ABHA's mobile, so the desk is offered to update it through the Profile API (profile/mobile/otp).
     */
    mobileUpdateOffered: boolean;
    /** The last 4 digits of the mobile ABDM holds on the ABHA, when its profile shows them. */
    abhaMobileLast4: string | null;
    communicationMobileLast4: string | null;
    linkedPatient: LinkedPatient | null;
}

/** The last 4 digits in a message such as "OTP sent to ... ending with ******0903." */
const lastFourDigits = (text: string | null | undefined): string | null => {
    const match = (text || "").match(/(\d{4})\D*$/);
    return match ? match[1]! : null;
};

/**
 * The last 4 digits of a mobile as ABDM shows it ("******0903", or a full number). Null when it
 * does not end in 4 digits, such as a mask that hides the end: unknown, never a guess.
 */
export const trailingFourDigits = (mobile: string | null | undefined): string | null => {
    const match = (mobile || "").trim().match(/(\d{4})$/);
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

/**
 * Reads the ABHA profile again after its mobile changed, so the desk sees what ABDM now holds
 * instead of what was typed. The addresses and ABHA number the session already knows stay (an
 * address login's own address, one created a moment ago). A failed read returns null and leaves
 * the session's profile as it was: the mobile change itself stands.
 */
export const rereadProfile = async (
    gateway: Pick<AbdmGatewayService, "call">,
    session: Pick<AbhaSession, "abhaAddress" | "profile">,
    xToken: string,
    timeoutMs: number = PROFILE_REREAD_TIMEOUT_MS,
): Promise<AbhaProfileSummary | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const read = gateway.call<Record<string, any>>({
            operation: "profile/account (after a mobile change)",
            method: "GET",
            path: "/abha/api/v3/profile/account",
            headers: { "X-token": `Bearer ${xToken}` },
        });
        // A late failure after the bound has nowhere to go: it is dropped, not left unhandled.
        read.catch(() => undefined);
        const timedOut = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
        const response = await Promise.race([read, timedOut]);
        if (response === null) {
            console.warn(`[ABDM] The ABHA profile was not read again after its mobile changed: no answer within ${timeoutMs / 1000} s`);
            return null;
        }
        const fresh = toProfileSummary(response);
        const known = [session.abhaAddress, ...(session.profile?.abhaAddresses ?? [])];
        for (const value of known) {
            const address = text(value);
            if (address && !fresh.abhaAddresses.some((held) => held.toLowerCase() === address.toLowerCase())) fresh.abhaAddresses.push(address);
        }
        fresh.abhaNumber = fresh.abhaNumber ?? session.profile?.abhaNumber ?? null;
        session.profile = fresh;
        return fresh;
    } catch (error: any) {
        console.warn(`[ABDM] Could not read the ABHA profile again after its mobile changed (${error?.message ?? error})`);
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
};

/**
 * How long the profile read after a mobile change may take. The change itself is already
 * confirmed, and the browser gives the whole request 30 s, so the read gives up well before.
 */
export const PROFILE_REREAD_TIMEOUT_MS = 8_000;

/** How many address suggestions the desk is offered (CRT_ABHA_112 asks for at least 3; the desk wants 10 to 12). */
export const ADDRESS_SUGGESTIONS_WANTED = 12;

const lettersOf = (value: string | null | undefined): string => (value ?? "").toLowerCase().replace(/[^a-z]/g, "");

/**
 * The address suggestions the desk is shown, each meeting the ABHA address rules printed beside the
 * field (checkAbhaAddress: 8 to 18 characters before the suffix, one dot and one underscore at
 * most, neither first nor last, letters and digits) and starting with a letter (ABDM's address
 * policy). ABDM's own suggestions come first, those that meet the rules. While fewer than
 * ADDRESS_SUGGESTIONS_WANTED remain, addresses built from the patient's name and date of birth are
 * added. ABDM may answer that one of those is taken; the address step offers another then.
 */
export const addressSuggestions = (fromAbdm: unknown[], profile: AbhaProfileSummary | null, suffix: string, held: string[] = []): string[] => {
    const heldLocal = new Set(held.map((address) => text(address).toLowerCase().replace(/@(sbx|abdm)$/i, "")));
    const shown: string[] = [];
    const offer = (candidate: unknown) => {
        const local = text(candidate).replace(/@(sbx|abdm)$/i, "");
        if (!local || !/^[a-z]/i.test(local) || checkAbhaAddress(local, suffix).broken.length > 0) return;
        const key = local.toLowerCase();
        if (heldLocal.has(key) || shown.some((address) => address.toLowerCase() === key)) return;
        shown.push(local);
    };
    fromAbdm.forEach(offer);
    if (shown.length >= ADDRESS_SUGGESTIONS_WANTED || !profile) return shown;

    // The name's letters only (no spaces, digits or marks), from its parts or, failing those, the full name.
    const fullParts = text(profile.fullName).split(/\s+/).map(lettersOf).filter(Boolean);
    const first = lettersOf(profile.firstName) || fullParts[0] || "";
    const last = lettersOf(profile.lastName) || (fullParts.length > 1 ? fullParts[fullParts.length - 1]! : "");
    if (!first) return shown;
    const middle = lettersOf(profile.middleName);
    const fi = first[0]!;
    const li = last.slice(0, 1);
    const dob = (profile.dateOfBirth ?? "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
    const [dd, mm, yyyy] = dob ? [dob[1]!, dob[2]!, dob[3]!] : ["", "", ""];
    const yy = yyyy.slice(2);
    // Digits to add: from the date of birth, then those ABDM put at the end of its own suggestions,
    // then a few plain ones so a one-word name with no date of birth still gets a full choice.
    const abdmTails = fromAbdm.map((candidate) => text(candidate).replace(/@(sbx|abdm)$/i, "").match(/(\d{2,4})$/)?.[1] ?? "");
    // Longer plain ones too, so a short name still reaches the 8-character minimum.
    const tails = [...new Set([yy, dd && mm ? dd + mm : "", mm && yy ? mm + yy : "", yyyy, dd, ...abdmTails,
        "01", "07", "11", "21", "99", "123", "0101", "1234", "2121", "7777", "9090"].filter(Boolean))];

    // Whole names only: an address never cuts a name in the middle while a whole one still fits.
    const maxLocal = ABHA_ADDRESS_MAX;
    const whole = (candidate: string): string => (candidate.length <= maxLocal ? candidate : "");
    // Forms that need a last name (or a middle one) are left out without one, never built half empty.
    const withLast = (...forms: string[]): string[] => (last ? forms : []);
    const nameOnly = [
        ...withLast(first + last, `${first}.${last}`, `${first}_${last}`),
        ...withLast(last + first, `${last}.${first}`, `${last}_${first}`),
        ...withLast(fi + last, `${fi}.${last}`, `${fi}_${last}`),
        ...withLast(`${first}.${li}`, `${first}_${li}`, first + li),
        ...(middle ? [first + middle, `${first}.${middle}`] : []),
        first,
        ...withLast(last),
    ].map(whole);
    const heads = [first, ...withLast(`${first}.${li}`, `${first}_${last}`, first + last, fi + last, `${first}.${last}`, `${last}_${fi}`, last)];
    const withDigits = tails.flatMap((tail) => [
        ...heads.map((head) => whole(head + tail)),
        whole(`${first}.${tail}`), whole(`${first}_${tail}`),
    ]);
    // A mix: a name, then a name with digits, so the list is not ten spellings of one form.
    const mixed: string[] = [];
    for (let i = 0; i < Math.max(nameOnly.length, withDigits.length); i += 1) mixed.push(nameOnly[i] ?? "", withDigits[i] ?? "");
    // Last of all, names shortened to fit, for names too long for any whole form.
    const fit = (head: string, tail = ""): string => head.slice(0, Math.max(0, maxLocal - tail.length)).replace(/[._]+$/, "") + tail;
    const shortened = [
        ...withLast(fit(first + last), fit(`${first}.${last}`), fit(`${first}_${last}`)),
        ...tails.flatMap((tail) => [fit(first, tail), fit(first, `.${tail}`), fit(first, `_${tail}`)]),
        ...withLast(...tails.map((tail) => fit(first + last, tail))),
    ];

    for (const candidate of [...mixed, ...shortened]) {
        if (shown.length >= ADDRESS_SUGGESTIONS_WANTED) break;
        if (candidate) offer(candidate);
    }
    return shown;
};

/**
 * Runs what follows an OTP ABDM has accepted (a token exchange, a profile read): a failure in it
 * is marked stage "after-otp", which the response carries, so the screen never calls it a wrong OTP.
 */
export const afterOtpAccepted = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
        return await step();
    } catch (error) {
        if (error && typeof error === "object") (error as { stage?: string }).stage = "after-otp";
        throw error;
    }
};

/** A different number sent too often in one journey. */
export const mobileChangeLimitError = (): AbhaJourneyError =>
    new AbhaJourneyError(429, "change-limit", "The mobile number has been changed too many times in this journey. Go on without it, or start again.");

export type AbhaAddressRule = "length" | "characters" | "oneDot" | "oneUnderscore" | "edges" | "notMobile";

/** An ABHA address is 8 to 18 characters before its @sbx or @abdm suffix (see checkAbhaAddress). */
export const ABHA_ADDRESS_MIN = 8;
export const ABHA_ADDRESS_MAX = 18;

/**
 * The ABHA address rules printed beside the field (CRT_ABHA_112): 8 to 18 characters, letters and
 * digits, at most one dot and one underscore, neither first nor last; not a mobile number.
 * The length is counted without the @sbx or @abdm suffix, as ABDM's sandbox enforces it: it
 * refused "Invalid ABHA Address" for 7 characters before @sbx (2026-11-11), and issues and
 * suggests addresses of 18 characters before it (CRT_ABHA_112 run, 2026-10-27). The sheet's
 * "(including @sbx)" does not match ABDM. Returns the local part (without suffix) and the rules it breaks.
 */
export const checkAbhaAddress = (input: string, _suffix: string): { localPart: string; broken: AbhaAddressRule[] } => {
    const localPart = input.trim().replace(/@(sbx|abdm)$/i, "");
    const broken: AbhaAddressRule[] = [];
    if (localPart.length < ABHA_ADDRESS_MIN || localPart.length > ABHA_ADDRESS_MAX) broken.push("length");
    if (!/^[A-Za-z0-9._]+$/.test(localPart)) broken.push("characters");
    if ((localPart.match(/\./g) || []).length > 1) broken.push("oneDot");
    if ((localPart.match(/_/g) || []).length > 1) broken.push("oneUnderscore");
    if (/^[._]|[._]$/.test(localPart)) broken.push("edges");
    if (/^[6-9]\d{9}$/.test(localPart)) broken.push("notMobile");
    return { localPart, broken };
};

/** The consent record's BeneficiaryName column holds 200 characters. */
export const BENEFICIARY_NAME_MAX = 200;

export const assertConsent = (consent: AbhaConsentInput | undefined): void => {
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
    // The beneficiary's confirmation names them (typed on the consent screen, as ABDM's review
    // asked), and the record keeps who consented: a consent with no name is not recorded.
    const name = text(consent!.beneficiaryName);
    if (!name) {
        throw new AbhaJourneyError(400, "consent", "Enter the beneficiary's name on the consent screen before the Aadhaar number is sent.");
    }
    if (name.length > BENEFICIARY_NAME_MAX) {
        throw new AbhaJourneyError(400, "consent", `Keep the beneficiary's name to ${BENEFICIARY_NAME_MAX} characters.`);
    }
};

/** The consent record kept before an Aadhaar number goes to ABDM: only the known declarations, as booleans. */
export const consentRecord = (consent: AbhaConsentInput, who: Pick<NewAbhaConsent, "staffUserId" | "staffName" | "hospitalId" | "organizationId" | "agreedAt">): NewAbhaConsent => ({
    consentCode: CONSENT_CODE,
    consentVersion: CONSENT_VERSION,
    declarations: JSON.stringify({
        termsAccepted: true,
        aadhaarSharing: consent.declarations.aadhaarSharing === true,
        otherDocument: consent.declarations.otherDocument === true,
        linkRecords: consent.declarations.linkRecords === true,
        shareWithProviders: consent.declarations.shareWithProviders === true,
        anonymisedUse: consent.declarations.anonymisedUse === true,
        staffConfirmed: true,
        beneficiaryConfirmed: true,
        language: /^[a-z]{2}$/.test(String(consent.language ?? "")) ? consent.language : "en",
    }),
    beneficiaryName: text(consent.beneficiaryName) || null,
    ...who,
});

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
        const consentId = await this.store.saveConsent(consentRecord(input.consent, {
            staffUserId: input.staffUserId,
            staffName: await this.store.staffName(input.staffUserId),
            hospitalId: input.hospitalId ?? null,
            organizationId: input.organizationId ?? null,
            agreedAt: new Date(this.clock()),
        }));

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

        // A 200 that says the OTP failed is a refused OTP, never an ABHA (the transaction is kept for a retry).
        const authResult = text(response.authResult).toLowerCase();
        if (authResult && authResult !== "success") {
            throw new AbhaJourneyError(422, "rejected", "ABDM did not verify the OTP.", { abdmMessage: textOrNull(response.message) });
        }
        const tokens = response.tokens ?? response.jwtResponse ?? (response.token ? { token: response.token } : null);
        const profile = toProfileSummary(response);
        // The flag decides what the desk is told; the message is only a fallback when ABDM omits it.
        const newFlag = response.isNew ?? response.new;
        const isNew = newFlag === undefined ? /created/i.test(text(response.message)) : newFlag === true || newFlag === "true";

        // A new ABHA whose communication mobile is not the Aadhaar-linked one verifies it next.
        // An existing ABHA keeps the mobile it already has (ABDM does not take this one for it), so
        // a different communication mobile is offered as an update of the ABHA's mobile instead
        // (CRT_ABHA_109 for an Aadhaar that already holds an ABHA). An ABHA mobile ABDM does not
        // show counts as different. Everything that can still fail runs before ABDM's answer is
        // committed to the session, so a failure here can be retried instead of stranding an ABHA
        // that now exists.
        const abhaMobileLast4 = trailingFourDigits(profile.mobile);
        const linkedLast4 = session.aadhaarMobileLast4 ?? abhaMobileLast4;
        const mobileVerificationNeeded = isNew && linkedLast4 !== mobile.slice(-4);
        const mobileUpdateOffered = !isNew && abhaMobileLast4 !== mobile.slice(-4);
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
            session.communicationMobile = { encrypted: encryptedMobile, last4: mobile.slice(-4), key: mobileKey(mobile), otp: null, sent: {}, verified: false, changes: 0, reread: false };
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
            mobileUpdateOffered,
            abhaMobileLast4,
            communicationMobileLast4: session.communicationMobile?.last4 ?? null,
            linkedPatient,
        };
    }

    /**
     * Sends (or resends) the OTP that verifies a new ABHA's communication mobile. [newMobile] is the
     * number on the mobile step: the same one again is a resend, under the resend rules; a corrected
     * one is a fresh send to that number (ABDM: only Resend counts toward the limit), at most
     * MOBILE_CHANGE_LIMIT times in a journey.
     */
    async requestMobileOtp(sessionId: string, staffUserId: string, newMobile?: unknown): Promise<{ message: string; resendsLeft: number; resendAvailableInSeconds: number; communicationMobileLast4: string }> {
        const session = this.session(sessionId, staffUserId);
        const mobile = session.communicationMobile;
        if (!mobile) throw new AbhaJourneyError(409, "state", "This ABHA does not need its mobile number verified.");
        if (mobile.verified) throw new AbhaJourneyError(409, "state", "The mobile number is already verified.");
        let target = { encrypted: mobile.encrypted, last4: mobile.last4, key: mobile.key };
        if (newMobile !== undefined && newMobile !== null && newMobile !== "") {
            const typed = String(newMobile);
            if (!/^\d{10}$/.test(typed)) {
                throw new AbhaJourneyError(400, "validation", "Enter a valid 10-digit mobile number for ABHA communication.", { field: "mobile" });
            }
            if (mobileKey(typed) !== mobile.key) {
                if (mobile.changes >= MOBILE_CHANGE_LIMIT) throw mobileChangeLimitError();
                target = { encrypted: await this.crypto.encrypt(typed), last4: typed.slice(-4), key: mobileKey(typed) };
            }
        }
        const changed = target.key !== mobile.key;
        // A number already sent to in this journey (this one, or one the desk goes back to) is a
        // resend under its own counter and cooldown; only a number never sent to starts afresh.
        const earlier = mobile.sent[target.key] ?? null;
        if (earlier) assertCanResend(earlier, this.clock());

        const response = await withCertificateCheck(this.crypto, () => this.gateway.call<{ txnId?: string; message?: string }>({
            operation: "enrollment/request/otp (mobile-verify)",
            method: "POST",
            path: "/abha/api/v3/enrollment/request/otp",
            body: { txnId: session.txnId, scope: ["abha-enrol", "mobile-verify"], loginHint: "mobile", loginId: target.encrypted, otpSystem: "abdm" },
        }));
        // Only now is the corrected number the journey's: a failed send leaves the previous one, and its OTP, as they were.
        mobile.encrypted = target.encrypted;
        mobile.last4 = target.last4;
        mobile.key = target.key;
        if (changed) mobile.changes += 1;
        session.txnId = text(response.txnId) || session.txnId;
        mobile.otp = earlier ? { sentAt: this.clock(), resends: earlier.resends + 1 } : { sentAt: this.clock(), resends: 0 };
        mobile.sent[target.key] = mobile.otp;

        return {
            message: text(response.message) || `OTP sent to the mobile number ending with ${mobile.last4}.`,
            resendsLeft: OTP_MAX_RESENDS - mobile.otp.resends,
            resendAvailableInSeconds: OTP_RESEND_COOLDOWN_MS / 1000,
            communicationMobileLast4: mobile.last4,
        };
    }

    /**
     * Verifies the new ABHA's communication mobile, then reads the profile again so the desk sees
     * the mobile ABDM now holds (profile is null when that read failed; the mobile stays verified).
     * Asked again once verified (the browser gave up on the first answer), it answers the same.
     */
    async verifyMobileOtp(input: { sessionId: string; staffUserId: string; otp: string }): Promise<{ verified: true; message: string; profile: AbhaProfileSummary | null }> {
        const session = this.session(input.sessionId, input.staffUserId);
        const mobile = session.communicationMobile;
        if (mobile?.verified) {
            return { verified: true, message: "Mobile number verified.", profile: mobile.reread ? session.profile : null };
        }
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
        const profile = session.xToken ? await rereadProfile(this.gateway, session, session.xToken) : null;
        mobile.reread = profile !== null;
        return { verified: true, message: text(response.message) || "Mobile number verified.", profile };
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
        const fromAbdm = Array.isArray(response.abhaAddressList) ? response.abhaAddressList : [];
        const suffix = abdmConfig.abhaAddressSuffix;
        // Only addresses that meet the rules beside the field (and this server's own check on create).
        const suggestions = addressSuggestions(fromAbdm, session.profile, suffix, sessionAbhaAddresses(session));
        return { suggestions, suffix };
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
