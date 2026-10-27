import { abdmConfig } from "../../config/abdm.config.js";
import { AbdmApiError, abdmGatewayService, abdmNotConfiguredError, type AbdmGatewayService } from "./abdm-gateway.service.js";
import { abdmCryptoService, type AbdmCryptoService } from "./abdm-crypto.service.js";
import { AbhaSessionStore, type AbhaSession, type AbhaProfileSummary, type LoginAccount } from "./abha-session.store.js";
import {
    AADHAAR_INVALID_MESSAGE,
    AbhaJourneyError,
    OTP_MAX_RESENDS,
    OTP_RESEND_COOLDOWN_MS,
    assertCanResend,
    findLinkedPatient,
    requireSession,
    sessionAbhaAddresses,
    text,
    textOrNull,
    toProfileSummary,
    withCertificateCheck,
    type AbhaEnrolmentStore,
    type LinkedPatient,
} from "./abha-enrolment.service.js";

/**
 * ABDM M1 for a person who already holds an ABHA, at the front desk:
 *   Verify by ABHA number (Aadhaar OTP or ABHA mobile OTP), by ABHA address (the PHR login,
 *   offering only the methods ABDM lists for that address) or by Aadhaar OTP;
 *   Find a forgotten ABHA by mobile: search, choose one account, OTP for that account only.
 * Every route ends with the ABHA profile and a verified session, which the card and the link to
 * the clinic's patient record (abha-enrolment.service) then use.
 *
 * Only ABDM-1114 means nobody holds an ABHA for an identifier; the screen offers creation on that.
 */

export type LoginMethod = "abha-number" | "abha-address" | "aadhaar";
export type LoginOtpSystem = "aadhaar" | "abdm";

export interface OtpSent {
    sessionId: string;
    message: string;
    resendsLeft: number;
    resendAvailableInSeconds: number;
}

export type LoginResult =
    | {
        status: "verified";
        message: string;
        abhaNumber: string | null;
        abhaAddress: string | null;
        profile: AbhaProfileSummary;
        linkedPatient: LinkedPatient | null;
        /** An ABHA-address login's token cannot update the profile mobile. */
        canUpdateMobile: boolean;
    }
    | { status: "choose-account"; message: string; accounts: LoginAccount[] };

const ABHA_LOGIN_REQUEST = "/abha/api/v3/profile/login/request/otp";
const ABHA_LOGIN_VERIFY = "/abha/api/v3/profile/login/verify";
const PHR_LOGIN_REQUEST = "/abha/api/v3/phr/web/login/abha/request/otp";
const PHR_LOGIN_VERIFY = "/abha/api/v3/phr/web/login/abha/verify";

/** 14 digits, with or without dashes, becomes 91-1234-5678-9012: ABDM validates the dashed form. */
export const normalizeAbhaNumber = (input: unknown): string | null => {
    const raw = String(input ?? "").trim();
    if (!/^[\d\s-]+$/.test(raw)) return null;
    const digits = raw.replace(/\D/g, "");
    if (digits.length !== 14) return null;
    return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}-${digits.slice(10)}`;
};

/** An address typed without its @sbx / @abdm suffix gets the one this environment uses. */
export const normalizeAbhaAddress = (input: unknown, suffix: string): string | null => {
    const raw = String(input ?? "").trim().toLowerCase();
    if (!raw || /\s/.test(raw)) return null;
    return raw.includes("@") ? raw : `${raw}${suffix}`;
};

/** The one ABDM answer that means nobody holds an ABHA for the identifier. */
const NO_ABHA_CODE = "ABDM-1114";

/** ABDM names auth methods MOBILE_OTP / AADHAAR_OTP on the PHR search; the OTP system behind each. */
const OTP_SYSTEM_FOR_METHOD: Record<string, LoginOtpSystem> = { MOBILE_OTP: "abdm", AADHAAR_OTP: "aadhaar" };

export class AbhaLoginService {
    private readonly store: Pick<AbhaEnrolmentStore, "findPatientByAbhaNumber" | "findPatientByAbhaAddresses">;
    private readonly gateway: Pick<AbdmGatewayService, "call">;
    private readonly crypto: Pick<AbdmCryptoService, "encrypt" | "invalidate">;
    private readonly clock: () => number;
    private readonly sessions: AbhaSessionStore;

    constructor(
        store: Pick<AbhaEnrolmentStore, "findPatientByAbhaNumber" | "findPatientByAbhaAddresses">,
        sessions: AbhaSessionStore,
        gateway: Pick<AbdmGatewayService, "call"> = abdmGatewayService,
        crypto: Pick<AbdmCryptoService, "encrypt" | "invalidate"> = abdmCryptoService,
        clock: () => number = Date.now,
    ) {
        this.store = store;
        this.sessions = sessions;
        this.gateway = gateway;
        this.crypto = crypto;
        this.clock = clock;
    }

    /**
     * The OTP methods ABDM offers for an ABHA address (VRFY_ABHA_102): the screen shows these and
     * nothing else. Asks nothing of the patient and sends no OTP.
     */
    async searchAbhaAddress(input: { abhaAddress: string }): Promise<{ abhaAddress: string; otpSystems: LoginOtpSystem[]; fullName: string | null; mobile: string | null }> {
        const abhaAddress = normalizeAbhaAddress(input.abhaAddress, abdmConfig.abhaAddressSuffix);
        if (!abhaAddress) {
            throw new AbhaJourneyError(400, "validation", "Enter the patient's ABHA address, for example name@sbx.", { field: "abhaAddress" });
        }
        this.assertConfigured("phr/web/login/abha/search");

        const response = await this.gateway.call<Record<string, any>>({
            operation: "phr/web/login/abha/search",
            method: "POST",
            path: "/abha/api/v3/phr/web/login/abha/search",
            body: { abhaAddress },
        });
        const blocked = new Set(Array.isArray(response.blockedAuthMethods) ? response.blockedAuthMethods : []);
        const listed: string[] = Array.isArray(response.authMethods) ? response.authMethods : [];
        const otpSystems = listed
            .filter((method) => !blocked.has(method) && OTP_SYSTEM_FOR_METHOD[method])
            .map((method) => OTP_SYSTEM_FOR_METHOD[method]!)
            .filter((system, i, all) => all.indexOf(system) === i);

        return {
            abhaAddress: textOrNull(response.abhaAddress) ?? abhaAddress,
            otpSystems,
            fullName: textOrNull(response.fullName),
            mobile: textOrNull(response.mobile),
        };
    }

    /** Sends the login OTP for an ABHA number, an ABHA address or an Aadhaar number. */
    async requestLoginOtp(input: { method: LoginMethod; identifier: string; otpSystem?: LoginOtpSystem; staffUserId: string }): Promise<OtpSent> {
        const otpSystem: LoginOtpSystem = input.method === "aadhaar" ? "aadhaar" : input.otpSystem === "aadhaar" ? "aadhaar" : "abdm";
        const verifyCheck = otpSystem === "aadhaar" ? "aadhaar-verify" : "mobile-verify";

        let identifier: string;
        let loginHint: string;
        let scope: string[];
        let family: "abha" | "phr" = "abha";
        if (input.method === "abha-number") {
            const abhaNumber = normalizeAbhaNumber(input.identifier);
            if (!abhaNumber) throw new AbhaJourneyError(400, "validation", "Enter the 14-digit ABHA number.", { field: "identifier" });
            identifier = abhaNumber;
            loginHint = "abha-number";
            scope = ["abha-login", verifyCheck];
        } else if (input.method === "aadhaar") {
            const aadhaar = String(input.identifier ?? "");
            if (!/^\d{12}$/.test(aadhaar)) throw new AbhaJourneyError(400, "validation", AADHAAR_INVALID_MESSAGE, { field: "identifier" });
            identifier = aadhaar;
            loginHint = "aadhaar";
            scope = ["abha-login", "aadhaar-verify"];
        } else if (input.method === "abha-address") {
            const address = normalizeAbhaAddress(input.identifier, abdmConfig.abhaAddressSuffix);
            if (!address) throw new AbhaJourneyError(400, "validation", "Enter the patient's ABHA address, for example name@sbx.", { field: "identifier" });
            identifier = address;
            loginHint = "abha-address";
            scope = ["abha-address-login", verifyCheck];
            family = "phr";
        } else {
            throw new AbhaJourneyError(400, "validation", "Choose how to verify the ABHA: ABHA number, ABHA address or Aadhaar.");
        }
        this.assertConfigured("login/request/otp");

        const requestPath = family === "phr" ? PHR_LOGIN_REQUEST : ABHA_LOGIN_REQUEST;
        const requestBody = { scope, loginHint, loginId: await this.crypto.encrypt(identifier), otpSystem };
        const response = await withCertificateCheck(this.crypto, () => this.gateway.call<{ txnId?: string; message?: string }>({
            operation: `${family === "phr" ? "phr/web/login/abha" : "profile/login"}/request/otp (${loginHint}, ${otpSystem})`,
            method: "POST",
            path: requestPath,
            body: requestBody,
        }));

        const session = this.sessions.create({
            staffUserId: input.staffUserId,
            flow: "verify",
            txnId: this.requireTxnId(response.txnId, "login/request/otp"),
            loginAbhaAddress: family === "phr" ? identifier : null,
            login: {
                family,
                requestPath,
                requestBody,
                verifyPath: family === "phr" ? PHR_LOGIN_VERIFY : ABHA_LOGIN_VERIFY,
                verifyScope: scope,
                otp: { sentAt: this.clock(), resends: 0 },
            },
        });
        return this.otpSent(session, text(response.message) || "OTP sent.");
    }

    /**
     * Find a forgotten ABHA by mobile: lists every ABHA on that mobile, so the desk can pick one
     * before any OTP is sent. An empty list means no ABHA is linked to the number.
     */
    async findByMobile(input: { mobile: string; staffUserId: string }): Promise<{ sessionId: string | null; accounts: { index: number; abhaNumber: string; name: string; gender: string | null }[] }> {
        const mobile = String(input.mobile ?? "");
        if (!/^\d{10}$/.test(mobile)) {
            throw new AbhaJourneyError(400, "validation", "Please enter a valid mobile number.", { field: "mobile" });
        }
        this.assertConfigured("profile/account/abha/search");

        let response: unknown;
        try {
            const encryptedMobile = await this.crypto.encrypt(mobile);
            response = await withCertificateCheck(this.crypto, () => this.gateway.call({
                operation: "profile/account/abha/search",
                method: "POST",
                path: "/abha/api/v3/profile/account/abha/search",
                body: { scope: ["search-abha"], mobile: encryptedMobile },
            }));
        } catch (error) {
            // Only ABDM-1114 says no ABHA is linked to the mobile: that is an answer, not a failure.
            // Any other refusal, a 404 from ABDM's API manager included, never answered the question.
            if (error instanceof AbdmApiError && error.code?.toUpperCase() === NO_ABHA_CODE) {
                return { sessionId: null, accounts: [] };
            }
            throw error;
        }

        // The documented answer is an array whose first item lists the accounts in ABHA. Any other
        // shape does not say whether the mobile holds an ABHA, so the desk is not told it holds none.
        const first: Record<string, any> | null = Array.isArray(response) && response[0] && typeof response[0] === "object" ? response[0] : null;
        if (!first || !Array.isArray(first.ABHA)) throw this.unexpectedSearchAnswer();
        if (first.ABHA.length === 0) return { sessionId: null, accounts: [] };
        const accounts = first.ABHA
            .map((account: any) => ({
                index: Number(account?.index),
                abhaNumber: text(account?.ABHANumber),
                name: text(account?.name),
                gender: textOrNull(account?.gender),
                authMethods: Array.isArray(account?.authMethods) ? account.authMethods.map(String) : [],
            }))
            .filter((account: { index: number }) => Number.isFinite(account.index));
        if (accounts.length === 0) throw this.unexpectedSearchAnswer();

        const session = this.sessions.create({
            staffUserId: input.staffUserId,
            flow: "find",
            txnId: this.requireTxnId(first.txnId, "profile/account/abha/search"),
            foundAccounts: accounts,
        });
        return {
            sessionId: session.id,
            accounts: accounts.map(({ index, abhaNumber, name, gender }: { index: number; abhaNumber: string; name: string; gender: string | null }) => ({ index, abhaNumber, name, gender })),
        };
    }

    /** Sends the OTP for the one account the desk chose; never before a choice (VRFY_ABHA_302). */
    async requestFindOtp(input: { sessionId: string; staffUserId: string; index: number }): Promise<OtpSent> {
        const session = requireSession(this.sessions, input.sessionId, input.staffUserId);
        const account = session.flow === "find" ? session.foundAccounts?.find((candidate) => candidate.index === Number(input.index)) : undefined;
        if (!account) {
            throw new AbhaJourneyError(400, "validation", "Choose one of the ABHA accounts found for this mobile.");
        }
        if (session.verified) {
            throw new AbhaJourneyError(409, "state", "This ABHA is already verified.");
        }

        const requestBody = {
            scope: ["abha-login", "search-abha", "mobile-verify"],
            loginHint: "index",
            loginId: await this.crypto.encrypt(String(account.index)),
            otpSystem: "abdm",
            txnId: session.txnId,
        };
        const response = await withCertificateCheck(this.crypto, () => this.gateway.call<{ txnId?: string; message?: string }>({
            operation: "profile/login/request/otp (index)",
            method: "POST",
            path: ABHA_LOGIN_REQUEST,
            body: requestBody,
        }));
        session.txnId = text(response.txnId) || session.txnId;
        session.login = {
            family: "abha",
            requestPath: ABHA_LOGIN_REQUEST,
            requestBody,
            verifyPath: ABHA_LOGIN_VERIFY,
            verifyScope: ["abha-login", "mobile-verify"],
            otp: { sentAt: this.clock(), resends: 0 },
        };
        return this.otpSent(session, text(response.message) || "OTP sent to the mobile number linked to this ABHA.");
    }

    /** Resends the pending login OTP on the same transaction, under the shared resend rule. */
    async resendLoginOtp(input: { sessionId: string; staffUserId: string }): Promise<OtpSent> {
        const session = requireSession(this.sessions, input.sessionId, input.staffUserId);
        const login = session.login;
        if (!login || session.verified) {
            throw new AbhaJourneyError(409, "state", "There is no OTP waiting to be resent.");
        }
        assertCanResend(login.otp, this.clock());

        const response = await withCertificateCheck(this.crypto, () => this.gateway.call<{ txnId?: string; message?: string }>({
            operation: "login/request/otp (resend)",
            method: "POST",
            path: login.requestPath,
            body: { ...login.requestBody, txnId: session.txnId },
        }));
        session.txnId = text(response.txnId) || session.txnId;
        login.otp = { sentAt: this.clock(), resends: login.otp.resends + 1 };
        return this.otpSent(session, text(response.message) || "OTP sent again.");
    }

    /**
     * Verifies the login OTP. A wrong OTP leaves the transaction as it was. A response carrying a
     * refresh token has already issued the user token; one without it issued a short-lived token
     * that verify/user exchanges, after the desk picks an account when there is more than one.
     * When the OTP already verified but the profile read after it failed, a repeat finishes from
     * the user token held, without a new OTP.
     */
    async verifyLoginOtp(input: { sessionId: string; staffUserId: string; otp: string }): Promise<LoginResult> {
        const session = requireSession(this.sessions, input.sessionId, input.staffUserId);
        if (this.awaitingProfile(session)) return this.finishWithProfile(session, "OTP verified successfully");
        const login = session.login;
        if (!login) throw new AbhaJourneyError(409, "state", "Send the OTP first.");
        if (session.verified) throw new AbhaJourneyError(409, "state", "This ABHA is already verified.");
        const otp = String(input.otp ?? "");
        if (!/^\d{6}$/.test(otp)) throw new AbhaJourneyError(400, "validation", "Enter the 6-digit OTP.", { field: "otp" });

        const encryptedOtp = await this.crypto.encrypt(otp);
        const response = await withCertificateCheck(this.crypto, () => this.gateway.call<Record<string, any>>({
            operation: `${login.family === "phr" ? "phr/web/login/abha" : "profile/login"}/verify`,
            method: "POST",
            path: login.verifyPath,
            body: {
                scope: login.verifyScope,
                authData: { authMethods: ["otp"], otp: { txnId: session.txnId, otpValue: encryptedOtp } },
            },
        }));
        const authResult = text(response.authResult).toLowerCase();
        if (authResult && authResult !== "success") {
            throw new AbhaJourneyError(422, "rejected", "ABDM did not verify the OTP.", { abdmMessage: textOrNull(response.message) });
        }
        session.txnId = text(response.txnId) || session.txnId;
        const message = text(response.message) || "OTP verified successfully";
        // The PHR verify sends the user token inside tokens{token, expiresIn}; the ABHA login at the top level.
        const tokens: Record<string, any> = login.family === "phr" && response.tokens && typeof response.tokens === "object" ? response.tokens : {};
        const token = textOrNull(tokens.token) ?? textOrNull(response.token);
        if (!token) {
            throw new AbdmApiError({ status: 502, kind: "unavailable", operation: "login/verify", message: "ABDM verified the OTP but sent no token." });
        }

        if (login.family === "phr") {
            this.holdUserToken(session, token, tokens.expiresIn ?? response.expiresIn, "phr");
            return this.finishWithProfile(session, message);
        }
        if (textOrNull(response.refreshToken)) {
            this.holdUserToken(session, token, response.expiresIn, "abha");
            return this.finishWithProfile(session, message);
        }

        // A short-lived token: exchanged for the user token at verify/user, for the chosen account.
        session.tToken = token;
        const accounts: LoginAccount[] = (Array.isArray(response.accounts) ? response.accounts : [])
            .map((account: any) => ({
                abhaNumber: text(account.ABHANumber),
                abhaAddress: textOrNull(account.preferredAbhaAddress),
                name: text(account.name),
                status: textOrNull(account.status),
            }))
            .filter((account: LoginAccount) => account.abhaNumber);
        if (accounts.length === 0) {
            throw new AbdmApiError({ status: 502, kind: "unavailable", operation: "login/verify", message: "ABDM verified the OTP but listed no ABHA account." });
        }
        session.loginAccounts = accounts;
        if (accounts.length === 1) {
            return this.selectAccount({ sessionId: session.id, staffUserId: input.staffUserId, abhaNumber: accounts[0]!.abhaNumber });
        }
        return { status: "choose-account", message, accounts };
    }

    /**
     * Exchanges the short-lived token for the chosen account's user token (verify/user). When the
     * exchange succeeded but the profile read after it failed, choosing that account again
     * finishes from the user token held.
     */
    async selectAccount(input: { sessionId: string; staffUserId: string; abhaNumber: string }): Promise<LoginResult> {
        const session = requireSession(this.sessions, input.sessionId, input.staffUserId);
        const account = session.loginAccounts?.find((candidate) => candidate.abhaNumber === String(input.abhaNumber ?? ""));
        if (account && this.awaitingProfile(session)) return this.finishWithProfile(session, "ABHA verified.");
        if (!account || !session.tToken) {
            throw new AbhaJourneyError(400, "validation", "Choose one of the ABHA accounts ABDM listed.");
        }

        const response = await this.gateway.call<Record<string, any>>({
            operation: "profile/login/verify/user",
            method: "POST",
            path: "/abha/api/v3/profile/login/verify/user",
            headers: { "T-token": `Bearer ${session.tToken}` },
            body: { ABHANumber: account.abhaNumber, txnId: session.txnId },
        });
        const token = textOrNull(response.token);
        if (!token) {
            throw new AbdmApiError({ status: 502, kind: "unavailable", operation: "profile/login/verify/user", message: "ABDM sent no user token for the chosen account." });
        }
        session.tToken = null;
        // The user token is this account's alone: a retry after a failed profile read can only choose it.
        session.loginAccounts = [account];
        this.holdUserToken(session, token, response.expiresIn, "abha");
        return this.finishWithProfile(session, text(response.message) || "ABHA verified.");
    }

    /**
     * VRFY_ABHA_101/201: when the clinic's record holds a different mobile, the desk may update the
     * ABHA profile's mobile. Only an ABHA number, Aadhaar or mobile login's token can do this.
     */
    async requestProfileMobileOtp(input: { sessionId: string; staffUserId: string; mobile: string }): Promise<OtpSent> {
        const session = this.verifiedAbhaSession(input.sessionId, input.staffUserId);
        const mobile = String(input.mobile ?? "");
        if (!/^\d{10}$/.test(mobile)) throw new AbhaJourneyError(400, "validation", "Enter a valid 10-digit mobile number.", { field: "mobile" });
        if (session.profileMobile?.last4 === mobile.slice(-4)) assertCanResend(session.profileMobile.otp, this.clock());

        const encryptedMobile = await this.crypto.encrypt(mobile);
        const response = await withCertificateCheck(this.crypto, () => this.gateway.call<{ txnId?: string; message?: string }>({
            operation: "profile/account/request/otp (update mobile)",
            method: "POST",
            path: "/abha/api/v3/profile/account/request/otp",
            headers: { "X-token": `Bearer ${session.xToken}` },
            body: {
                scope: ["abha-profile", "mobile-verify"],
                loginHint: "mobile",
                loginId: encryptedMobile,
                otpSystem: "abdm",
                ...(session.profileMobile?.last4 === mobile.slice(-4) ? { txnId: session.profileMobile.txnId } : {}),
            },
        }));
        const previous = session.profileMobile?.last4 === mobile.slice(-4) ? session.profileMobile.otp : null;
        session.profileMobile = {
            txnId: this.requireTxnId(response.txnId, "profile/account/request/otp"),
            last4: mobile.slice(-4),
            otp: previous ? { sentAt: this.clock(), resends: previous.resends + 1 } : { sentAt: this.clock(), resends: 0 },
        };
        return this.otpSent(session, text(response.message) || `OTP sent to the mobile number ending with ${mobile.slice(-4)}.`, session.profileMobile.otp.resends);
    }

    async verifyProfileMobileOtp(input: { sessionId: string; staffUserId: string; otp: string }): Promise<{ updated: true; message: string }> {
        const session = this.verifiedAbhaSession(input.sessionId, input.staffUserId);
        const pending = session.profileMobile;
        if (!pending) throw new AbhaJourneyError(409, "state", "Send the OTP to the new mobile number first.");
        const otp = String(input.otp ?? "");
        if (!/^\d{6}$/.test(otp)) throw new AbhaJourneyError(400, "validation", "Enter the 6-digit OTP.", { field: "otp" });

        const encryptedOtp = await this.crypto.encrypt(otp);
        const response = await withCertificateCheck(this.crypto, () => this.gateway.call<{ authResult?: string; message?: string }>({
            operation: "profile/account/verify (update mobile)",
            method: "POST",
            path: "/abha/api/v3/profile/account/verify",
            headers: { "X-token": `Bearer ${session.xToken}` },
            body: {
                scope: ["abha-profile", "mobile-verify"],
                authData: { authMethods: ["otp"], otp: { txnId: pending.txnId, otpValue: encryptedOtp } },
            },
        }));
        if (text(response.authResult).toLowerCase() !== "success") {
            throw new AbhaJourneyError(422, "rejected", "ABDM did not update the mobile number.", { abdmMessage: textOrNull(response.message) });
        }
        session.profileMobile = null;
        return { updated: true, message: text(response.message) || "Mobile number linked successfully" };
    }

    private holdUserToken(session: AbhaSession, token: string, expiresIn: unknown, kind: "abha" | "phr"): void {
        const seconds = Number(expiresIn);
        session.xToken = token;
        session.xTokenExpiresAt = this.clock() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 1800) * 1000;
        session.tokenKind = kind;
        session.login = null;
    }

    /**
     * Reads the profile with the user token, and only then marks the session verified. A failed read
     * keeps the token, so the desk's next Verify finishes from it instead of needing a new OTP.
     */
    private async finishWithProfile(session: AbhaSession, message: string): Promise<LoginResult> {
        const phr = session.tokenKind === "phr";
        const response = await this.gateway.call<Record<string, any>>({
            operation: phr ? "phr/web/login/profile/abha-profile" : "profile/account",
            method: "GET",
            path: phr ? "/abha/api/v3/phr/web/login/profile/abha-profile" : "/abha/api/v3/profile/account",
            headers: { "X-token": `Bearer ${session.xToken}` },
        });
        const profile = toProfileSummary(response);
        // An ABHA-address login keeps the address the patient gave, not the account's preferred one.
        const loginAddress = session.loginAbhaAddress;
        if (loginAddress && !profile.abhaAddresses.some((address) => address.toLowerCase() === loginAddress)) {
            profile.abhaAddresses.push(loginAddress);
        }
        const abhaAddress = loginAddress ?? profile.abhaAddresses[0] ?? null;
        const linkedPatient = await findLinkedPatient(this.store, profile.abhaNumber, sessionAbhaAddresses({ abhaAddress, profile }));

        session.verified = true;
        session.profile = profile;
        session.abhaNumber = profile.abhaNumber;
        session.abhaAddress = abhaAddress;
        session.loginAccounts = null;

        return {
            status: "verified",
            message,
            abhaNumber: session.abhaNumber,
            abhaAddress: session.abhaAddress,
            profile,
            linkedPatient,
            canUpdateMobile: !phr,
        };
    }

    /** ABDM accepted the OTP and a live user token is held, but the profile read after it failed. */
    private awaitingProfile(session: AbhaSession): boolean {
        return session.flow !== "create"
            && !session.verified
            && !session.login
            && !!session.xToken
            && (session.xTokenExpiresAt === null || this.clock() < session.xTokenExpiresAt);
    }

    private unexpectedSearchAnswer(): AbdmApiError {
        return new AbdmApiError({ status: 502, kind: "unavailable", operation: "profile/account/abha/search", message: "ABDM sent an unexpected response to the ABHA search." });
    }

    private verifiedAbhaSession(sessionId: string, staffUserId: string): AbhaSession {
        const session = requireSession(this.sessions, sessionId, staffUserId);
        if (!session.verified || !session.xToken) throw new AbhaJourneyError(409, "state", "Verify the ABHA first.");
        if (session.tokenKind !== "abha") {
            throw new AbhaJourneyError(409, "state", "The mobile number can't be updated after an ABHA address login. Verify with the ABHA number instead.");
        }
        if (session.xTokenExpiresAt !== null && this.clock() >= session.xTokenExpiresAt) {
            throw new AbhaJourneyError(410, "session-ended", "The ABHA session has timed out. Verify the patient again.");
        }
        return session;
    }

    private otpSent(session: AbhaSession, message: string, resends: number = session.login?.otp.resends ?? 0): OtpSent {
        return {
            sessionId: session.id,
            message,
            resendsLeft: OTP_MAX_RESENDS - resends,
            resendAvailableInSeconds: OTP_RESEND_COOLDOWN_MS / 1000,
        };
    }

    private requireTxnId(value: unknown, operation: string): string {
        const txnId = text(value);
        if (!txnId) {
            throw new AbdmApiError({ status: 502, kind: "unavailable", operation, message: "ABDM sent no transaction id." });
        }
        return txnId;
    }

    private assertConfigured(operation: string): void {
        if (!abdmConfig.isConfigured) throw abdmNotConfiguredError(operation);
    }
}
