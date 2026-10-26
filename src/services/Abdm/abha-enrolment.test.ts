import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AbdmApiError, type AbdmCall } from "./abdm-gateway.service.js";
import {
    AADHAAR_INVALID_MESSAGE,
    AbhaEnrolmentService,
    AbhaJourneyError,
    RESEND_LIMIT_MESSAGE,
    checkAbhaAddress,
    toProfileSummary,
    type AbhaConsentInput,
    type AbhaEnrolmentStore,
    type LinkedPatient,
    type NewAbhaConsent,
} from "./abha-enrolment.service.js";

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
let patients: Map<string, { name: string; abhaNumber: string | null; abhaAddress: string | null }>;
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
    async patientExists(userId) {
        return patients.has(userId);
    },
    async linkAbha(userId, abhaNumber, abhaAddress) {
        Object.assign(patients.get(userId)!, { abhaNumber, abhaAddress });
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
        [PATIENT, { name: "Asha Kumari", abhaNumber: null, abhaAddress: null }],
        [OTHER_PATIENT, { name: "Someone Else", abhaNumber: null, abhaAddress: null }],
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
        throw new Error(`unexpected call ${call.path}`);
    };
    service = new AbhaEnrolmentService(store, gateway, fakeCrypto, () => now);
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

test("isNew false is an existing ABHA: reported as such, carried on, no mobile step", async () => {
    answer = ((normal) => (call: AbdmCall) => (call.path.endsWith("/enrol/byAadhaar") ? enrolled(false) : normal(call)))(answer);
    const { sessionId } = await startJourney();

    const result = await service.verifyAadhaarOtp({ sessionId, staffUserId: STAFF, otp: "123456", mobile: "9000011111" });

    assert.equal(result.isNew, false);
    assert.equal(result.message, "This account already exist");
    assert.equal(result.abhaNumber, ABHA_NUMBER);
    assert.equal(result.abhaAddress, "asha.kumari@sbx");
    assert.equal(result.mobileVerificationNeeded, false);
    assert.equal(result.profile.dateOfBirth, "05-08-1990");
    assert.ok(!JSON.stringify(result).includes(X_TOKEN), "the user token never leaves the server");
    assert.ok(!JSON.stringify(result).includes("refresh-token"), "nor the refresh token");

    // The address step stays open for an existing account.
    const { suggestions } = await service.getAddressSuggestions(sessionId, STAFF);
    assert.equal(suggestions.length, 3);
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
    assert.deepEqual(calls.at(-1)!.body, {
        scope: ["abha-enrol", "mobile-verify"],
        authData: { authMethods: ["otp"], otp: { txnId: "txn-3", otpValue: "enc(654321)" } },
    });
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

    await service.linkToPatient({ sessionId, staffUserId: STAFF, userId: PATIENT });
    assert.equal(patients.get(PATIENT)!.abhaNumber, ABHA_NUMBER);
    assert.equal(patients.get(PATIENT)!.abhaAddress, "asha.kumari@sbx");
    assert.equal(consents.get(1)!.patientUserId, PATIENT);

    await assert.rejects(
        service.linkToPatient({ sessionId, staffUserId: STAFF, userId: OTHER_PATIENT }),
        (error: unknown) => error instanceof AbhaJourneyError && error.status === 409 && (error.details.linkedPatient as LinkedPatient).userId === PATIENT,
    );
    assert.equal(patients.get(OTHER_PATIENT)!.abhaNumber, null);
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
