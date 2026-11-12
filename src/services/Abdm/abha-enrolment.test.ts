import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AbdmApiError, type AbdmCall } from "./abdm-gateway.service.js";
import {
    AADHAAR_INVALID_MESSAGE,
    AbhaEnrolmentService,
    AbhaJourneyError,
    BENEFICIARY_NAME_MAX,
    PROFILE_REREAD_TIMEOUT_MS,
    RESEND_LIMIT_MESSAGE,
    assertConsent,
    rereadProfile,
    ADDRESS_SUGGESTIONS_WANTED,
    addressSuggestions,
    checkAbhaAddress,
    toProfileSummary,
    type AbhaConsentInput,
    type AbhaEnrolmentStore,
    type LinkedPatient,
    type NewAbhaConsent,
} from "./abha-enrolment.service.js";
import { AbhaSessionStore } from "./abha-session.store.js";
import { AbhaLoginService } from "./abha-login.service.js";

const STAFF = "11111111-1111-1111-1111-111111111111";
const PATIENT = "22222222-2222-2222-2222-222222222222";
const OTHER_PATIENT = "33333333-3333-3333-3333-333333333333";
const AADHAAR = "123412341234";
const X_TOKEN = "user-x-token-stays-on-the-server";
const ABHA_NUMBER = "91-1111-2222-3333";

const consent: AbhaConsentInput = {
    termsAccepted: true,
    declarations: { aadhaarSharing: true, otherDocument: false, linkRecords: true, shareWithProviders: true, anonymisedUse: true },
    staffConfirmed: true,
    beneficiaryConfirmed: true,
    beneficiaryName: "Asha Kumari",
};

/** Stands in for RSA: tests check what was encrypted, the crypto test checks how. */
const fakeCrypto = {
    invalidated: 0,
    async encrypt(plain: string) {
        return `enc(${plain})`;
    },
    invalidate() {
        fakeCrypto.invalidated += 1;
    },
};

type Answer = (call: AbdmCall) => unknown;

let events: string[];
let calls: AbdmCall[];
let answer: Answer;
let now: number;
let consents: Map<number, NewAbhaConsent & { txnId?: string; abhaNumber?: string; patientUserId?: string }>;
let patients: Map<string, { name: string; abhaNumber: string | null; abhaAddress: string | null; abhaAddresses: string[]; isPatient?: boolean; linkedAtHospital?: number | null }>;
let sessions: AbhaSessionStore;
let service: AbhaEnrolmentService;

const store: AbhaEnrolmentStore = {
    async saveConsent(row) {
        events.push("consent saved");
        const id = consents.size + 1;
        consents.set(id, { ...row });
        return id;
    },
    async updateConsent(id, changes) {
        Object.assign(consents.get(id)!, changes);
    },
    async staffName() {
        return "Front Desk Priya";
    },
    async findPatientByAbhaNumber(abhaNumber): Promise<LinkedPatient | null> {
        for (const [userId, patient] of patients) {
            if (patient.abhaNumber === abhaNumber) return { userId, name: patient.name, tokenNumber: null };
        }
        return null;
    },
    async findPatientByAbhaAddresses(abhaAddresses): Promise<LinkedPatient | null> {
        for (const [userId, patient] of patients) {
            if (patient.abhaAddresses.some((address) => abhaAddresses.includes(address))) return { userId, name: patient.name, tokenNumber: null };
        }
        return null;
    },
    async getPatient(userId) {
        const patient = patients.get(userId);
        return patient ? { abhaNumber: patient.abhaNumber, abhaAddresses: patient.abhaAddresses, isPatient: patient.isPatient !== false } : null;
    },
    async linkAbha(userId, abha, hospitalId) {
        const patient = patients.get(userId)!;
        Object.assign(patient, {
            abhaNumber: abha.abhaNumber ?? patient.abhaNumber,
            abhaAddress: abha.abhaAddress ?? patient.abhaAddress,
            abhaAddresses: [...new Set([...patient.abhaAddresses, ...abha.abhaAddresses])],
            linkedAtHospital: hospitalId,
        });
    },
};

const gateway = {
    async call<T>(call: AbdmCall): Promise<T> {
        events.push(`call ${call.operation}`);
        calls.push(call);
        const result = answer(call);
        if (result instanceof Error) throw result;
        return result as T;
    },
};

const otpSent = { txnId: "txn-1", message: "OTP sent to Aadhaar registered mobile number ending with ******0903" };
const enrolled = (isNew: boolean) => ({
    message: isNew ? "Account created successfully" : "This account already exist",
    txnId: "txn-2",
    isNew,
    tokens: { token: X_TOKEN, expiresIn: 1800, refreshToken: "refresh-token-stays-on-the-server", refreshExpiresIn: 1296000 },
    ABHAProfile: {
        ABHANumber: ABHA_NUMBER,
        firstName: "Asha",
        middleName: "",
        lastName: "Kumari",
        dob: "05-08-1990",
        gender: "F",
        mobile: "******0903",
        phrAddress: ["asha.kumari@sbx"],
        address: "12 MG Road",
        districtName: "Pune",
        stateName: "MAHARASHTRA",
        pinCode: "411001",
        abhaStatus: "ACTIVE",
    },
});

const startJourney = () => service.requestAadhaarOtp({ aadhaar: AADHAAR, consent, staffUserId: STAFF, hospitalId: 19, organizationId: 1 });

beforeEach(() => {
    process.env.ABDM_CLIENT_ID = "SBX_TEST";
    process.env.ABDM_CLIENT_SECRET = "secret";
    events = [];
    calls = [];
    now = 1_000_000;
    fakeCrypto.invalidated = 0;
    consents = new Map();
    patients = new Map([
        [PATIENT, { name: "Asha Kumari", abhaNumber: null, abhaAddress: null, abhaAddresses: [] }],
        [OTHER_PATIENT, { name: "Someone Else", abhaNumber: null, abhaAddress: null, abhaAddresses: [] }],
    ]);
    answer = (call) => {
        if (call.path.endsWith("/enrollment/request/otp")) {
            const mobileVerify = (call.body as any)?.scope?.includes("mobile-verify");
            return mobileVerify ? { txnId: "txn-3", message: "OTP sent to mobile number ending with ******1111" } : otpSent;
        }
        if (call.path.endsWith("/enrollment/enrol/byAadhaar")) return enrolled(true);
        if (call.path.endsWith("/enrollment/auth/byAbdm")) return { txnId: "txn-3", authResult: "success", message: "Mobile verified" };
        if (call.path.endsWith("/enrollment/enrol/suggestion")) return { txnId: "txn-2", abhaAddressList: ["asha.kumari", "asha1990", "kumari.asha"] };
        if (call.path.endsWith("/enrollment/enrol/abha-address")) return { txnId: "txn-2", healthIdNumber: ABHA_NUMBER, preferredAbhaAddress: "asha.k_99@sbx" };
        if (call.path.endsWith("/profile/account/abha-card")) return { contentType: "image/png", data: Buffer.from("png-bytes") };
        if (call.path.endsWith("/profile/account/request/otp")) return { txnId: "txn-profile", message: "OTP sent to mobile number ending with ******1111" };
        if (call.path.endsWith("/profile/account/verify")) return { txnId: "txn-profile", authResult: "success", message: "Mobile Number linked successfully" };
        // The profile as ABDM holds it once a mobile was linked: the new number, masked.
        if (call.path.endsWith("/profile/account")) return { ...enrolled(true).ABHAProfile, mobile: "******1111" };
        throw new Error(`unexpected call ${call.path}`);
    };
    sessions = new AbhaSessionStore(() => now);
    service = new AbhaEnrolmentService(store, gateway, fakeCrypto, () => now, sessions);
});

test("an invalid Aadhaar number is refused on our side and nothing is sent or stored", async () => {
    for (const aadhaar of ["12341234123", "1234123412345", "12341234123a", "1234-1234-12"]) {
        await assert.rejects(
            service.requestAadhaarOtp({ aadhaar, consent, staffUserId: STAFF }),
            (error: unknown) => error instanceof AbhaJourneyError && error.message === AADHAAR_INVALID_MESSAGE,
        );
    }
    assert.equal(calls.length, 0);
    assert.equal(consents.size, 0);
});

test("without the full consent the Aadhaar number is never sent", async () => {
    const partial = { ...consent, beneficiaryConfirmed: false };
    await assert.rejects(service.requestAadhaarOtp({ aadhaar: AADHAAR, consent: partial, staffUserId: STAFF }), (error: unknown) => error instanceof AbhaJourneyError && error.kind === "consent");
    assert.equal(calls.length, 0);
    assert.equal(consents.size, 0);
});

test("without the beneficiary's name the consent is not recorded and the Aadhaar number is never sent", async () => {
    for (const beneficiaryName of [undefined, "", "   "]) {
        await assert.rejects(
            service.requestAadhaarOtp({ aadhaar: AADHAAR, consent: { ...consent, beneficiaryName }, staffUserId: STAFF }),
            (error: unknown) => error instanceof AbhaJourneyError && error.kind === "consent" && error.status === 400 && /beneficiary's name/.test(error.message),
        );
    }
    // Longer than the consent record's 200-character column.
    await assert.rejects(
        service.requestAadhaarOtp({ aadhaar: AADHAAR, consent: { ...consent, beneficiaryName: "x".repeat(BENEFICIARY_NAME_MAX + 1) }, staffUserId: STAFF }),
        (error: unknown) => error instanceof AbhaJourneyError && error.kind === "consent" && /200 characters/.test(error.message),
    );
    assert.equal(calls.length, 0);
    assert.equal(consents.size, 0);
});

test("the beneficiary's name is recorded trimmed, and 200 characters fit", async () => {
    await service.requestAadhaarOtp({ aadhaar: AADHAAR, consent: { ...consent, beneficiaryName: "  Asha Kumari  " }, staffUserId: STAFF });
    assert.equal(consents.get(1)!.beneficiaryName, "Asha Kumari");
    assert.doesNotThrow(() => assertConsent({ ...consent, beneficiaryName: ` ${"x".repeat(BENEFICIARY_NAME_MAX)} ` }));
});

test("consent is recorded before the OTP request, which carries the encrypted Aadhaar", async () => {
    const result = await startJourney();

    assert.deepEqual(events, ["consent saved", "call enrollment/request/otp (aadhaar)"]);
    const [request] = calls;
    assert.deepEqual(request!.body, { scope: ["abha-enrol"], loginHint: "aadhaar", loginId: `enc(${AADHAAR})`, otpSystem: "aadhaar" });
    assert.equal(result.message, otpSent.message);
    assert.equal(result.resendsLeft, 2);

    const stored = consents.get(1)!;
    assert.equal(stored.staffUserId, STAFF);
    assert.equal(stored.staffName, "Front Desk Priya");
    assert.equal(stored.beneficiaryName, "Asha Kumari");
    assert.equal(stored.consentCode, "abha-enrollment");
    assert.equal(stored.consentVersion, "1.4");
    assert.equal(stored.txnId, "txn-1");
    assert.ok(!JSON.stringify(stored).includes(AADHAAR), "the Aadhaar number is not stored with the consent");
});

test("nothing is sent and no consent stored when ABDM is not configured", async () => {
    delete process.env.ABDM_CLIENT_ID;
    await assert.rejects(startJourney(), (error: unknown) => error instanceof AbdmApiError && error.kind === "not-configured");
    assert.equal(calls.length, 0);
    assert.equal(consents.size, 0);
});

test("resend waits 60 seconds, reuses the transaction, and stops after two", async () => {
    const { sessionId } = await startJourney();

    await assert.rejects(service.resendAadhaarOtp(sessionId, STAFF), (error: unknown) => error instanceof AbhaJourneyError && error.kind === "resend-wait");

    now += 60_000;
    const first = await service.resendAadhaarOtp(sessionId, STAFF);
    assert.equal(first.resendsLeft, 1);
    assert.deepEqual(calls[1]!.body, { txnId: "txn-1", scope: ["abha-enrol"], loginHint: "aadhaar", loginId: `enc(${AADHAAR})`, otpSystem: "aadhaar" });

    now += 60_000;
    const second = await service.resendAadhaarOtp(sessionId, STAFF);
    assert.equal(second.resendsLeft, 0);

    now += 60_000;
    await assert.rejects(service.resendAadhaarOtp(sessionId, STAFF), (error: unknown) => error instanceof AbhaJourneyError && error.message === RESEND_LIMIT_MESSAGE);
    assert.equal(calls.length, 3, "the third resend never reaches ABDM");
});

test("a resend ABDM refuses on the transaction goes out once on a new one, which the journey takes over", async () => {
    const { sessionId } = await startJourney();
    let fresh = 0;
    answer = (call) => {
        if (call.path.endsWith("/enrollment/request/otp")) {
            if ((call.body as any).txnId) {
                return new AbdmApiError({ status: 400, kind: "rejected", operation: call.operation, field: "txnId", message: "Invalid Transaction Id", requestId: "rid" });
            }
            fresh += 1;
            return { txnId: `txn-new-${fresh}`, message: otpSent.message };
        }
        if (call.path.endsWith("/enrollment/enrol/byAadhaar")) return enrolled(true);
        throw new Error(`unexpected call ${call.path}`);
    };

    now += 60_000;
    const first = await service.resendAadhaarOtp(sessionId, STAFF);
    assert.equal(first.resendsLeft, 1);
    assert.equal(first.message, otpSent.message);
    assert.deepEqual(calls[1]!.body, { txnId: "txn-1", scope: ["abha-enrol"], loginHint: "aadhaar", loginId: `enc(${AADHAAR})`, otpSystem: "aadhaar" });
    assert.deepEqual(calls[2]!.body, { scope: ["abha-enrol"], loginHint: "aadhaar", loginId: `enc(${AADHAAR})`, otpSystem: "aadhaar" });
    assert.equal(consents.get(1)!.txnId, "txn-new-1");

    now += 60_000;
    const second = await service.resendAadhaarOtp(sessionId, STAFF);
    assert.equal(second.resendsLeft, 0);
    assert.equal((calls[3]!.body as any).txnId, "txn-new-1", "the next resend tries the transaction it took over");

    now += 60_000;
    await assert.rejects(service.resendAadhaarOtp(sessionId, STAFF), (error: unknown) => error instanceof AbhaJourneyError && error.message === RESEND_LIMIT_MESSAGE);
    assert.equal(calls.length, 5, "two resends, each tried on the transaction and then on a new one; the third never reaches ABDM");

    await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9876540903" });
    assert.equal((calls[5]!.body as any).authData.otp.txnId, "txn-new-2", "the OTP is verified on the newest transaction");
});

test("two resends pressed together send one", async () => {
    const { sessionId } = await startJourney();
    now += 60_000;
    const [first, second] = await Promise.allSettled([service.resendAadhaarOtp(sessionId, STAFF), service.resendAadhaarOtp(sessionId, STAFF)]);
    assert.equal(first.status, "fulfilled");
    assert.ok(second.status === "rejected" && second.reason instanceof AbhaJourneyError && second.reason.kind === "state");
    assert.equal(calls.length, 2, "the first send and one resend");
    assert.equal(first.status === "fulfilled" && first.value.resendsLeft, 1);
});

test("any other refusal of a resend is shown as it is and not sent again", async () => {
    const { sessionId } = await startJourney();
    const refusal = new AbdmApiError({ status: 400, kind: "rejected", operation: "enrollment/request/otp", field: "loginId", message: "Invalid LoginId" });
    answer = (call) => {
        if (call.path.endsWith("/enrollment/request/otp")) return refusal;
        throw new Error(`unexpected call ${call.path}`);
    };

    now += 60_000;
    await assert.rejects(service.resendAadhaarOtp(sessionId, STAFF), (error: unknown) => error === refusal);
    assert.equal(calls.length, 2, "one resend call, no second try");
});

test("a wrong OTP shows ABDM's message and keeps the transaction for the right one", async () => {
    const { sessionId } = await startJourney();
    const uidaiRefusal = new AbdmApiError({ status: 422, kind: "rejected", operation: "byAadhaar", code: "ABDM-1204", message: "UIDAI Error code : 400 : Invalid Aadhaar OTP value." });
    let attempts = 0;
    const normal = answer;
    answer = (call) => (call.path.endsWith("/enrol/byAadhaar") && ++attempts === 1 ? uidaiRefusal : normal(call));

    await assert.rejects(
        service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "111111", mobile: "9876540903" }),
        (error: unknown) => error === uidaiRefusal,
    );
    const result = await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "222222", mobile: "9876540903" });

    const byAadhaar = calls.filter((call) => call.path.endsWith("/enrol/byAadhaar"));
    assert.equal(byAadhaar[0]!.body && (byAadhaar[0]!.body as any).authData.otp.txnId, "txn-1");
    assert.equal((byAadhaar[1]!.body as any).authData.otp.txnId, "txn-1");
    assert.equal(result.isNew, true);
});

test("enrol/byAadhaar sends the encrypted OTP, the plain mobile and the consent block", async () => {
    const { sessionId } = await startJourney();
    await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9876540903" });

    const byAadhaar = calls.find((call) => call.path.endsWith("/enrol/byAadhaar"))!;
    assert.deepEqual(byAadhaar.body, {
        authData: { authMethods: ["otp"], otp: { txnId: "txn-1", otpValue: "enc(123456)", mobile: "9876540903" } },
        consent: { code: "abha-enrollment", version: "1.4" },
    });
});

test("isNew false is an existing ABHA: reported as such, carried on, its different mobile offered as an update", async () => {
    answer = ((normal) => (call: AbdmCall) => (call.path.endsWith("/enrol/byAadhaar") ? enrolled(false) : normal(call)))(answer);
    const { sessionId } = await startJourney();

    const result = await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9000011111" });

    assert.equal(result.isNew, false);
    assert.equal(result.message, "This account already exist");
    assert.equal(result.abhaNumber, ABHA_NUMBER);
    assert.equal(result.abhaAddress, "asha.kumari@sbx");
    // ABDM keeps the existing ABHA's own mobile (ending 0903): the typed one (1111) is offered as an update, not verified as a new ABHA's.
    assert.equal(result.mobileVerificationNeeded, false);
    assert.equal(result.mobileUpdateOffered, true);
    assert.equal(result.abhaMobileLast4, "0903");
    assert.equal(result.profile.dateOfBirth, "05-08-1990");
    assert.ok(!JSON.stringify(result).includes(X_TOKEN), "the user token never leaves the server");
    assert.ok(!JSON.stringify(result).includes("refresh-token"), "nor the refresh token");

    // The address step stays open for an existing account: ABDM's suggestions first (not the address
    // the ABHA already holds, asha.kumari), then more that meet the rules.
    const { suggestions } = await service.getAddressSuggestions(sessionId, STAFF);
    assert.deepEqual(suggestions.slice(0, 2), ["asha1990", "kumari.asha"]);
    assert.ok(!suggestions.includes("asha.kumari"));
    assert.ok(suggestions.length >= 3);
});

test("a communication mobile that is the Aadhaar-linked one needs no second OTP", async () => {
    const { sessionId } = await startJourney();
    const result = await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9876540903" });
    assert.equal(result.mobileVerificationNeeded, false);
    await assert.rejects(service.requestMobileOtp(sessionId, STAFF), (error: unknown) => error instanceof AbhaJourneyError && error.kind === "state");
});

test("a different communication mobile is verified by OTP, encrypted", async () => {
    const { sessionId } = await startJourney();
    const result = await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9000011111" });
    assert.equal(result.mobileVerificationNeeded, true);
    assert.equal(result.communicationMobileLast4, "1111");

    await service.requestMobileOtp(sessionId, STAFF);
    const mobileOtp = calls.at(-1)!;
    assert.deepEqual(mobileOtp.body, { txnId: "txn-2", scope: ["abha-enrol", "mobile-verify"], loginHint: "mobile", loginId: "enc(9000011111)", otpSystem: "abdm" });

    const verified = await service.verifyMobileOtp({ sessionId, staffUserId: STAFF, otp: "654321" });
    assert.equal(verified.verified, true);
    const byAbdm = calls.find((call) => call.path.endsWith("/enrollment/auth/byAbdm"))!;
    assert.deepEqual(byAbdm.body, {
        scope: ["abha-enrol", "mobile-verify"],
        authData: { authMethods: ["otp"], otp: { txnId: "txn-3", otpValue: "enc(654321)" } },
    });

    // The profile is read again with the user token: the summary shows the mobile ABDM now holds.
    const reread = calls.at(-1)!;
    assert.equal(reread.method, "GET");
    assert.equal(reread.path, "/abha/api/v3/profile/account");
    assert.equal(reread.headers?.["X-token"], `Bearer ${X_TOKEN}`);
    assert.equal(verified.profile?.mobile, "******1111");
    assert.ok(verified.profile?.abhaAddresses.includes("asha.kumari@sbx"), "the addresses the journey knows stay");
    assert.ok(!JSON.stringify(verified).includes(X_TOKEN), "the user token never leaves the server");
});

test("a failed profile read after the mobile is verified keeps it verified", async () => {
    answer = ((normal) => (call: AbdmCall) => (call.path === "/abha/api/v3/profile/account"
        ? new AbdmApiError({ status: 503, kind: "unavailable", operation: "profile/account", message: "Service Unavailable" })
        : normal(call)))(answer);
    const { sessionId } = await startJourney();
    await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9000011111" });
    await service.requestMobileOtp(sessionId, STAFF);

    const verified = await service.verifyMobileOtp({ sessionId, staffUserId: STAFF, otp: "654321" });
    assert.equal(verified.verified, true);
    assert.equal(verified.profile, null);
    assert.equal(sessions.get(sessionId, STAFF)!.communicationMobile?.verified, true);
});

test("the desk can correct the communication mobile on the mobile step: a fresh send, only Resend counts", async () => {
    const { sessionId } = await startJourney();
    await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9000011111" });

    // The number given with the Aadhaar OTP, sent as it is, then resent: the resend rules hold.
    await service.requestMobileOtp(sessionId, STAFF, "9000011111");
    assert.equal((calls.at(-1)!.body as any).loginId, "enc(9000011111)");
    await assert.rejects(service.requestMobileOtp(sessionId, STAFF, "9000011111"), (error: unknown) => error instanceof AbhaJourneyError && error.kind === "resend-wait");
    now += 60_000;
    assert.equal((await service.requestMobileOtp(sessionId, STAFF)).resendsLeft, 1, "a resend to the same number counts");

    // Corrected at once, even with Resend already used: a fresh send to the new number, its own counter.
    const corrected = await service.requestMobileOtp(sessionId, STAFF, "9000022222");
    assert.equal((calls.at(-1)!.body as any).loginId, "enc(9000022222)");
    assert.equal((calls.at(-1)!.body as any).txnId, "txn-3", "the same enrolment transaction");
    assert.equal(corrected.communicationMobileLast4, "2222");
    assert.equal(corrected.resendsLeft, 2);

    // Same last 4, different number: still another number, never mistaken for a resend.
    const sameLast4 = await service.requestMobileOtp(sessionId, STAFF, "9100022222");
    assert.equal((calls.at(-1)!.body as any).loginId, "enc(9100022222)");
    assert.equal(sameLast4.resendsLeft, 2);

    await assert.rejects(service.requestMobileOtp(sessionId, STAFF, "12345"), (error: unknown) => error instanceof AbhaJourneyError && error.status === 400);
});

test("one journey changes the communication mobile at most 3 times", async () => {
    const { sessionId } = await startJourney();
    await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9000011111" });
    for (const mobile of ["9000022222", "9000033333", "9000044444"]) await service.requestMobileOtp(sessionId, STAFF, mobile);
    const sent = calls.length;
    await assert.rejects(service.requestMobileOtp(sessionId, STAFF, "9000055555"), (error: unknown) => error instanceof AbhaJourneyError && error.kind === "change-limit" && error.status === 429);
    assert.equal(calls.length, sent, "nothing sent past the limit");
    // The last number can still be resent under the resend rules.
    now += 60_000;
    assert.equal((await service.requestMobileOtp(sessionId, STAFF, "9000044444")).communicationMobileLast4, "4444");
});

test("a verify asked again once the mobile is verified answers the same, without calling ABDM", async () => {
    const { sessionId } = await startJourney();
    await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9000011111" });
    await service.requestMobileOtp(sessionId, STAFF);
    const first = await service.verifyMobileOtp({ sessionId, staffUserId: STAFF, otp: "654321" });
    const sent = calls.length;

    const again = await service.verifyMobileOtp({ sessionId, staffUserId: STAFF, otp: "654321" });
    assert.equal(calls.length, sent, "the OTP is not sent to ABDM a second time");
    assert.equal(again.verified, true);
    assert.equal(again.profile?.mobile, first.profile?.mobile);
});

test("the profile read after a mobile change gives up within its bound and leaves the change standing", async () => {
    const session = { abhaAddress: "asha.kumari@sbx", profile: null };
    const hanging = { call: () => new Promise<never>(() => undefined) };
    const started = Date.now();
    assert.equal(await rereadProfile(hanging, session, X_TOKEN, 20), null);
    assert.ok(Date.now() - started < 2_000, "it does not wait for ABDM");
    assert.equal(session.profile, null, "nothing is overwritten");
    assert.ok(PROFILE_REREAD_TIMEOUT_MS <= 10_000, "well inside the browser's 30 s for the whole verify");
});

test("address suggestions carry the transaction id; the chosen address is created as preferred", async () => {
    const { sessionId } = await startJourney();
    await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9876540903" });

    await service.getAddressSuggestions(sessionId, STAFF);
    assert.equal(calls.at(-1)!.headers?.TRANSACTION_ID, "txn-2");

    await assert.rejects(
        service.createAbhaAddress({ sessionId, staffUserId: STAFF, abhaAddress: ".asha" }),
        (error: unknown) => error instanceof AbhaJourneyError && error.status === 400,
    );
    const created = await service.createAbhaAddress({ sessionId, staffUserId: STAFF, abhaAddress: "asha.k_99@sbx" });
    assert.deepEqual(calls.at(-1)!.body, { txnId: "txn-2", abhaAddress: "asha.k_99", preferred: 1 });
    assert.equal(created.abhaAddress, "asha.k_99@sbx");
});

test("the ABHA card is fetched with the user token as X-token", async () => {
    const { sessionId } = await startJourney();
    await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9876540903" });

    const card = await service.getAbhaCard(sessionId, STAFF);
    const request = calls.at(-1)!;
    assert.equal(request.headers?.["X-token"], `Bearer ${X_TOKEN}`);
    assert.equal(request.binary, true);
    assert.equal(card.contentType, "image/png");
    assert.equal(Buffer.from(card.base64, "base64").toString(), "png-bytes");

    now += 31 * 60_000;
    await assert.rejects(service.getAbhaCard(sessionId, STAFF), (error: unknown) => error instanceof AbhaJourneyError && error.status === 410);
});

test("the ABHA is linked from the verified session, once per patient", async () => {
    const { sessionId } = await startJourney();
    await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9876540903" });

    await service.linkToPatient({ sessionId, staffUserId: STAFF, userId: PATIENT, hospitalId: 19 });
    assert.equal(patients.get(PATIENT)!.abhaNumber, ABHA_NUMBER);
    assert.equal(patients.get(PATIENT)!.abhaAddress, "asha.kumari@sbx");
    assert.equal(patients.get(PATIENT)!.linkedAtHospital, 19, "the hospital's registration is flagged");
    assert.equal(consents.get(1)!.patientUserId, PATIENT);

    await assert.rejects(
        service.linkToPatient({ sessionId, staffUserId: STAFF, userId: OTHER_PATIENT }),
        (error: unknown) => error instanceof AbhaJourneyError && error.status === 409 && (error.details.linkedPatient as LinkedPatient).userId === PATIENT,
    );
    assert.equal(patients.get(OTHER_PATIENT)!.abhaNumber, null);
});

test("linking refuses a record that holds another ABHA, a non-patient, and a malformed id", async () => {
    const { sessionId } = await startJourney();
    await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9876540903" });

    patients.get(PATIENT)!.abhaNumber = "91-9999-8888-7777";
    await assert.rejects(
        service.linkToPatient({ sessionId, staffUserId: STAFF, userId: PATIENT }),
        (error: unknown) => error instanceof AbhaJourneyError && error.kind === "different-abha",
    );
    assert.equal(patients.get(PATIENT)!.abhaNumber, "91-9999-8888-7777", "the other ABHA is not overwritten");

    patients.get(OTHER_PATIENT)!.isPatient = false;
    await assert.rejects(
        service.linkToPatient({ sessionId, staffUserId: STAFF, userId: OTHER_PATIENT }),
        (error: unknown) => error instanceof AbhaJourneyError && error.kind === "not-a-patient",
    );
    await assert.rejects(
        service.linkToPatient({ sessionId, staffUserId: STAFF, userId: "not-a-guid" }),
        (error: unknown) => error instanceof AbhaJourneyError && error.status === 404,
    );
});

/** A verified ABHA-address login, as abha-login.service leaves it, for the link step to use. */
const verifiedAddressLogin = (abhaNumber: string | null, abhaAddress: string, others: string[] = []): string =>
    sessions.create({
        staffUserId: STAFF,
        flow: "verify",
        txnId: "txn-login",
        verified: true,
        tokenKind: "phr",
        xToken: X_TOKEN,
        abhaNumber,
        abhaAddress,
        profile: { ...toProfileSummary({ firstName: "Asha" }), abhaNumber, abhaAddresses: [...others, abhaAddress] },
    }).id;

test("every ABHA address is stored, and the one the record shows is the one the patient gave", async () => {
    const sessionId = verifiedAddressLogin(ABHA_NUMBER, "asha.work@sbx", ["asha.kumari@sbx"]);
    const linked = await service.linkToPatient({ sessionId, staffUserId: STAFF, userId: PATIENT });
    assert.deepEqual(linked, { abhaNumber: ABHA_NUMBER, abhaAddress: "asha.work@sbx" });
    assert.equal(patients.get(PATIENT)!.abhaAddress, "asha.work@sbx");
    assert.deepEqual(patients.get(PATIENT)!.abhaAddresses.sort(), ["asha.kumari@sbx", "asha.work@sbx"]);

    // Another desk holding a second address of the same ABHA finds the patient by it.
    patients.get(PATIENT)!.abhaNumber = null;
    const other = verifiedAddressLogin(null, "asha.kumari@sbx");
    await assert.rejects(
        service.linkToPatient({ sessionId: other, staffUserId: STAFF, userId: OTHER_PATIENT }),
        (error: unknown) => error instanceof AbhaJourneyError && error.kind === "already-linked",
    );
});

test("a re-verify that brings no address keeps the stored one", async () => {
    Object.assign(patients.get(PATIENT)!, { abhaNumber: ABHA_NUMBER, abhaAddress: "asha.kumari@sbx", abhaAddresses: ["asha.kumari@sbx"] });
    const sessionId = sessions.create({ staffUserId: STAFF, flow: "verify", txnId: "t", verified: true, xToken: X_TOKEN, abhaNumber: ABHA_NUMBER, abhaAddress: null, profile: toProfileSummary({ ABHANumber: ABHA_NUMBER }) }).id;
    const linked = await service.linkToPatient({ sessionId, staffUserId: STAFF, userId: PATIENT });
    assert.equal(linked.abhaAddress, null);
    assert.equal(patients.get(PATIENT)!.abhaAddress, "asha.kumari@sbx");
});

test("an ABHA address without an ABHA number links by its address, once per patient", async () => {
    const sessionId = verifiedAddressLogin(null, "asha.nokyc@sbx");
    const linked = await service.linkToPatient({ sessionId, staffUserId: STAFF, userId: PATIENT, hospitalId: 19 });
    assert.deepEqual(linked, { abhaNumber: null, abhaAddress: "asha.nokyc@sbx" });
    assert.equal(patients.get(PATIENT)!.abhaNumber, null);
    assert.deepEqual(patients.get(PATIENT)!.abhaAddresses, ["asha.nokyc@sbx"]);
    assert.equal(patients.get(PATIENT)!.linkedAtHospital, 19);

    await assert.rejects(
        service.linkToPatient({ sessionId, staffUserId: STAFF, userId: OTHER_PATIENT }),
        (error: unknown) => error instanceof AbhaJourneyError && error.kind === "already-linked" && (error.details.linkedPatient as LinkedPatient).userId === PATIENT,
    );
    // The same address again on the same record is fine.
    await service.linkToPatient({ sessionId, staffUserId: STAFF, userId: PATIENT });
});

test("an ABHA that shares nothing with the record's ABHA is refused, whichever side has no number", async () => {
    Object.assign(patients.get(PATIENT)!, { abhaNumber: "91-9999-8888-7777", abhaAddress: "ravi@sbx", abhaAddresses: ["ravi@sbx"] });
    await assert.rejects(
        service.linkToPatient({ sessionId: verifiedAddressLogin(null, "asha.nokyc@sbx"), staffUserId: STAFF, userId: PATIENT }),
        (error: unknown) => error instanceof AbhaJourneyError && error.kind === "different-abha",
    );

    Object.assign(patients.get(PATIENT)!, { abhaNumber: null, abhaAddress: "ravi.nokyc@sbx", abhaAddresses: ["ravi.nokyc@sbx"] });
    await assert.rejects(
        service.linkToPatient({ sessionId: verifiedAddressLogin(ABHA_NUMBER, "asha.kumari@sbx"), staffUserId: STAFF, userId: PATIENT }),
        (error: unknown) => error instanceof AbhaJourneyError && error.kind === "different-abha",
    );

    // An address-only record gains the ABHA number its address now belongs to.
    const sessionId = verifiedAddressLogin(ABHA_NUMBER, "asha.kumari@sbx", ["ravi.nokyc@sbx"]);
    await service.linkToPatient({ sessionId, staffUserId: STAFF, userId: PATIENT });
    assert.equal(patients.get(PATIENT)!.abhaNumber, ABHA_NUMBER);
});

test("a database hiccup after ABDM created the ABHA does not strand the journey", async () => {
    const failing = { ...store, findPatientByAbhaNumber: async () => { throw new Error("connection reset"); }, updateConsent: async () => { throw new Error("connection reset"); } };
    service = new AbhaEnrolmentService(failing, gateway, fakeCrypto, () => now);
    const { sessionId } = await service.requestAadhaarOtp({ aadhaar: AADHAAR, consent, staffUserId: STAFF });

    const result = await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9000011111" });
    assert.equal(result.abhaNumber, ABHA_NUMBER);
    assert.equal(result.mobileVerificationNeeded, true);
    assert.equal(result.linkedPatient, null);
});

test("verification reports a patient that already holds this ABHA", async () => {
    patients.get(PATIENT)!.abhaNumber = ABHA_NUMBER;
    const { sessionId } = await startJourney();
    const result = await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9876540903" });
    assert.deepEqual(result.linkedPatient, { userId: PATIENT, name: "Asha Kumari", tokenNumber: null });
});

test("a journey belongs to the staff member who started it", async () => {
    const { sessionId } = await startJourney();
    await assert.rejects(
        service.verifyAadhaarOtp({ sessionId, staffUserId: "44444444-4444-4444-4444-444444444444", otp: "123456", mobile: "9876540903" }),
        (error: unknown) => error instanceof AbhaJourneyError && error.status === 410,
    );
});

test("a refused encrypted field drops the cached certificate", async () => {
    answer = () => new AbdmApiError({ status: 400, kind: "rejected", operation: "request/otp", field: "loginId", message: "Invalid LoginId" });
    await assert.rejects(startJourney());
    assert.equal(fakeCrypto.invalidated, 1);
});

test("ABHA address rules", () => {
    assert.deepEqual(checkAbhaAddress("asha.k_99", "@sbx"), { localPart: "asha.k_99", broken: [] });
    assert.deepEqual(checkAbhaAddress("asha.k_99@sbx", "@sbx").broken, []);
    assert.deepEqual(checkAbhaAddress("ash", "@sbx").broken, ["length"]);
    assert.deepEqual(checkAbhaAddress("a.b.cdefg", "@sbx").broken, ["oneDot"]);
    assert.deepEqual(checkAbhaAddress("a_b_cdefg", "@sbx").broken, ["oneUnderscore"]);
    assert.deepEqual(checkAbhaAddress("_ashakum", "@sbx").broken, ["edges"]);
    assert.deepEqual(checkAbhaAddress("asha-kum", "@sbx").broken, ["characters"]);
    assert.ok(checkAbhaAddress("9876543210", "@sbx").broken.includes("notMobile"));
    assert.ok(checkAbhaAddress("averyveryverylongname", "@sbx").broken.includes("length"));
    // Counted before the suffix, as ABDM enforces it: 7 refused ("Invalid ABHA Address"), 8 to 18 accepted.
    assert.deepEqual(checkAbhaAddress("ravi.k1", "@sbx").broken, ["length"]);
    assert.deepEqual(checkAbhaAddress("ravi.k12", "@sbx").broken, []);
    assert.deepEqual(checkAbhaAddress("abcdefghijklmnopqr", "@sbx").broken, []);
    assert.deepEqual(checkAbhaAddress("abcdefghijklmnopqrs", "@sbx").broken, ["length"]);
    assert.deepEqual(checkAbhaAddress("abcdefghijklmnopqr@abdm", "@abdm").broken, []);
});

test("the older enrolment response shape becomes the same profile", () => {
    const profile = toProfileSummary({
        healthIdNumber: ABHA_NUMBER,
        healthId: "asha@sbx",
        firstName: "Asha",
        lastName: "Kumari",
        dayOfBirth: "5",
        monthOfBirth: "8",
        yearOfBirth: "1990",
        gender: "F",
    });
    assert.equal(profile.abhaNumber, ABHA_NUMBER);
    assert.deepEqual(profile.abhaAddresses, ["asha@sbx"]);
    assert.equal(profile.dateOfBirth, "05-08-1990");
});

test("an existing ABHA whose mobile is the communication mobile, by its last 4, is offered no update", async () => {
    answer = ((normal) => (call: AbdmCall) => (call.path.endsWith("/enrol/byAadhaar") ? enrolled(false) : normal(call)))(answer);
    const { sessionId } = await startJourney();
    const result = await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9876540903" });
    assert.equal(result.mobileUpdateOffered, false);
    assert.equal(result.mobileVerificationNeeded, false);
});

test("an existing ABHA whose profile shows no mobile digits is offered the update; a new ABHA never is", async () => {
    const hidden = (isNew: boolean) => {
        const response = enrolled(isNew);
        return { ...response, ABHAProfile: { ...response.ABHAProfile, mobile: "98XXXXXXXX" } };
    };
    answer = ((normal) => (call: AbdmCall) => (call.path.endsWith("/enrol/byAadhaar") ? hidden(false) : normal(call)))(answer);
    let journey = await startJourney();
    let result = await service.verifyAadhaarOtp({ sessionId: journey.sessionId, staffUserId: STAFF, otp: "123456", mobile: "9876540903" });
    assert.equal(result.abhaMobileLast4, null, "a mask that hides the end gives no digits, never a guess");
    assert.equal(result.mobileUpdateOffered, true);

    answer = ((normal) => (call: AbdmCall) => (call.path.endsWith("/enrol/byAadhaar") ? enrolled(true) : normal(call)))(answer);
    journey = await startJourney();
    result = await service.verifyAadhaarOtp({ sessionId: journey.sessionId, staffUserId: STAFF, otp: "123456", mobile: "9000011111" });
    assert.equal(result.mobileUpdateOffered, false);
    assert.equal(result.mobileVerificationNeeded, true);
});

test("an existing ABHA's mobile is updated through the Profile API with the token enrolment returned", async () => {
    answer = ((normal) => (call: AbdmCall) => (call.path.endsWith("/enrol/byAadhaar") ? enrolled(false) : normal(call)))(answer);
    const { sessionId } = await startJourney();
    const result = await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9000011111" });
    assert.equal(result.mobileUpdateOffered, true);

    // The same session store backs both services, as in the controller.
    const login = new AbhaLoginService(store, sessions, gateway, fakeCrypto, () => now);
    await login.requestProfileMobileOtp({ sessionId, staffUserId: STAFF, mobile: "9000011111" });
    const request = calls.at(-1)!;
    assert.equal(request.path, "/abha/api/v3/profile/account/request/otp");
    assert.equal(request.headers?.["X-token"], `Bearer ${X_TOKEN}`);
    assert.deepEqual(request.body, { scope: ["abha-profile", "mobile-verify"], loginHint: "mobile", loginId: "enc(9000011111)", otpSystem: "abdm" });

    const updated = await login.verifyProfileMobileOtp({ sessionId, staffUserId: STAFF, otp: "654321" });
    assert.equal(updated.updated, true);
    assert.equal(updated.profile?.mobile, "******1111");
    assert.equal(updated.profileShowsNewMobile, true);
    assert.ok(updated.profile?.abhaAddresses.includes("asha.kumari@sbx"));

    // The address step and the card carry on from the same journey.
    await service.getAddressSuggestions(sessionId, STAFF);
    assert.equal(calls.at(-1)!.headers?.TRANSACTION_ID, "txn-2");
});

test("a corrected number whose OTP ABDM fails to send is not kept: the earlier number and its OTP stand", async () => {
    const { sessionId } = await startJourney();
    await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9000011111" });
    await service.requestMobileOtp(sessionId, STAFF);
    now += 60_000;

    answer = ((normal) => (call: AbdmCall) => ((call.body as any)?.loginId === "enc(9000022222)"
        ? new AbdmApiError({ status: 503, kind: "unavailable", operation: "enrollment/request/otp", message: "Service Unavailable" })
        : normal(call)))(answer);
    await assert.rejects(service.requestMobileOtp(sessionId, STAFF, "9000022222"));

    const kept = sessions.get(sessionId, STAFF)!.communicationMobile!;
    assert.equal(kept.encrypted, "enc(9000011111)");
    assert.equal(kept.last4, "1111");
    assert.equal(kept.otp?.resends, 0, "the failed send is not counted");
    assert.equal(kept.changes, 0, "nor counted as a change");
});

test("going back to a communication mobile already sent to carries on its resends and cooldown", async () => {
    const { sessionId } = await startJourney();
    await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9000011111" });
    await service.requestMobileOtp(sessionId, STAFF);
    for (let i = 0; i < 2; i += 1) {
        now += 60_000;
        await service.requestMobileOtp(sessionId, STAFF);
    }
    now += 60_000;
    await assert.rejects(service.requestMobileOtp(sessionId, STAFF), (error: unknown) => error instanceof AbhaJourneyError && error.kind === "resend-limit");

    // Another number is a fresh send; going back to the spent one is not.
    assert.equal((await service.requestMobileOtp(sessionId, STAFF, "9000022222")).resendsLeft, 2);
    await assert.rejects(service.requestMobileOtp(sessionId, STAFF, "9000011111"), (error: unknown) => error instanceof AbhaJourneyError && error.kind === "resend-limit");
});

test("a 200 from enrol/byAadhaar that says the OTP failed is a refused OTP, and the right OTP can follow", async () => {
    let refuse = true;
    answer = ((normal) => (call: AbdmCall) => (call.path.endsWith("/enrol/byAadhaar") && refuse
        ? { authResult: "failed", message: "OTP validation failed" }
        : normal(call)))(answer);
    const { sessionId } = await startJourney();
    await assert.rejects(
        service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9876540903" }),
        (error: unknown) => error instanceof AbhaJourneyError && error.status === 422 && error.kind === "rejected" && error.details.abdmMessage === "OTP validation failed",
    );
    assert.equal(sessions.get(sessionId, STAFF)!.verified, false, "no ABHA is taken from a refused OTP");

    refuse = false;
    const result = await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "654321", mobile: "9876540903" });
    assert.equal(result.abhaNumber, ABHA_NUMBER);
});

test("address suggestions meet the ABHA address rules (8 to 18 before @sbx): ABDM's own come first, built ones fill in", () => {
    // What the sandbox suggests (shape of a real CRT_ABHA_112 journey, made-up name): 16 to 18 characters before @sbx,
    // valid under ABDM's own rule, plus one too long and one too short that are dropped.
    const fromAbdm = [
        "rameshkrishnan30", "rameshkrishnan0530", "rameshkrishnan05", "ramesh_rame30.3030", "ramesh_rame30.3005",
        "ramesh_rame30.0530", "ramesh_rame30.0505", "ramesh_rame053030", "ramesh_rame053020", "ramesh_rame053005",
        "rameshkrishnan053030", "ramesh.k",
    ];
    const profile = { ...toProfileSummary(enrolled(true)), firstName: "RAMESH", middleName: "", lastName: "KRISHNAN", fullName: "", dateOfBirth: "05-03-1990" };
    const shown = addressSuggestions(fromAbdm, profile, "@sbx", ["krishnan_72@sbx"]);

    assert.equal(shown.length, ADDRESS_SUGGESTIONS_WANTED);
    assert.deepEqual(shown.slice(0, 10), fromAbdm.slice(0, 10), "ABDM's valid ones first, in its order");
    assert.ok(!shown.includes("rameshkrishnan053030"), "20 before @sbx: too long");
    for (const address of shown) {
        assert.deepEqual(checkAbhaAddress(address, "@sbx").broken, [], `${address} meets every rule`);
        assert.ok(address.length >= 8 && address.length <= 18, `${address}: 8 to 18 before @sbx`);
        assert.match(address, /^[a-z]/, "starts with a letter");
    }
    assert.equal(new Set(shown.map((address) => address.toLowerCase())).size, shown.length, "no repeats");
    assert.ok(!shown.includes("krishnan_72"), "never an address the ABHA already holds");
});

test("ABDM's valid suggestions are kept first and in its order", () => {
    const valid = ["asha.k90", "ashak1990", "kumari.a", "asha_k05", "ashakumari", "asha.kum"];
    assert.deepEqual(addressSuggestions([...valid, "asha_kumari_1990"], null, "@sbx"), valid, "the invalid one (two underscores) dropped");
    // With no profile, only ABDM's valid ones; bad shapes never pass.
    assert.deepEqual(addressSuggestions(["9876543210", ".ashakumari", "1asha2024", "asha", "ashakumari@sbx", 42, null], null, "@sbx"), ["ashakumari"], "a mobile, an edge dot, a leading digit, a short one and non-strings are dropped; the suffix is taken off");
    // The suffix never counts toward the length, whichever it is.
    const profile = { ...toProfileSummary(enrolled(true)), firstName: "Bartholomew", lastName: "Featherstonehaugh", fullName: "", dateOfBirth: "05-08-1990" };
    for (const address of addressSuggestions([], profile, "@abdm")) {
        assert.ok(address.length >= 8 && address.length <= 18 && checkAbhaAddress(address, "@abdm").broken.length === 0, address);
    }
});

test("a one-word name with no full date of birth still gets at least 10 valid suggestions", () => {
    const base = toProfileSummary(enrolled(true));
    for (const firstName of ["VENKATALAKSHMI", "RAVI"]) {
        const profile = { ...base, firstName, middleName: "", lastName: "", fullName: "", dateOfBirth: null };
        for (const fromAbdm of [[], ["venkatalakshmi1990", "venkatalakshmi.1990", "venkatalakshmi_1990"]]) {
            const shown = addressSuggestions(fromAbdm, profile, "@sbx");
            assert.ok(shown.length >= 10, `${firstName}: ${shown.length} suggestions`);
            for (const address of shown) assert.deepEqual(checkAbhaAddress(address, "@sbx").broken, [], address);
        }
    }
});

test("a two-part name gets 12 varied suggestions: names in either order, initials, dots, underscores and digits, never a cut name while a whole one fits", () => {
    const profile = { ...toProfileSummary(enrolled(true)), firstName: "RAMESH", middleName: "", lastName: "KRISHNAN", fullName: "", dateOfBirth: "05-03-1990" };
    const shown = addressSuggestions([], profile, "@sbx");
    assert.equal(shown.length, 12);
    for (const address of shown) assert.deepEqual(checkAbhaAddress(address, "@sbx").broken, [], address);
    for (const expected of ["rameshkrishnan", "krishnanramesh", "ramesh.krishnan", "ramesh_krishnan", "krishnan.ramesh", "ramesh90", "rkrishnan90"]) assert.ok(shown.includes(expected), expected);
    assert.ok(shown.filter((address) => /\d/.test(address)).length >= 4, "some with digits");
    assert.ok(shown.filter((address) => !/\d/.test(address)).length >= 4, "some without");
    assert.ok(shown.some((address) => address.includes(".")) && shown.some((address) => address.includes("_")), "dots and underscores");
    // A cut name would leave "krishna" without its "n", or "rames" without its "h".
    assert.ok(!shown.some((address) => /krishna(?!n)|rames(?!h)/.test(address)), "no name cut short");
});
