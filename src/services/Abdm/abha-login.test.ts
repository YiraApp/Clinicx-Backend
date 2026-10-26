import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AbdmApiError, type AbdmCall } from "./abdm-gateway.service.js";
import { AbhaJourneyError, RESEND_LIMIT_MESSAGE } from "./abha-enrolment.service.js";
import { AbhaLoginService, normalizeAbhaAddress, normalizeAbhaNumber } from "./abha-login.service.js";
import { AbhaSessionStore } from "./abha-session.store.js";

const STAFF = "11111111-1111-1111-1111-111111111111";
const X_TOKEN = "x-token-stays-on-the-server";
const T_TOKEN = "t-token-stays-on-the-server";
const ABHA_NUMBER = "91-1111-2222-3333";

const fakeCrypto = { async encrypt(plain: string) { return `enc(${plain})`; }, invalidate() {} };
const accountProfile = {
    ABHANumber: ABHA_NUMBER,
    preferredAbhaAddress: "asha.kumari@sbx",
    firstName: "Asha",
    lastName: "Kumari",
    dayOfBirth: "5",
    monthOfBirth: "8",
    yearOfBirth: "1990",
    gender: "F",
    mobile: "******0903",
    kycVerified: true,
};

let calls: AbdmCall[];
let answer: (call: AbdmCall) => unknown;
let now: number;
let service: AbhaLoginService;

const gateway = {
    async call<T>(call: AbdmCall): Promise<T> {
        calls.push(call);
        const result = answer(call);
        if (result instanceof Error) throw result;
        return result as T;
    },
};

beforeEach(() => {
    process.env.ABDM_CLIENT_ID = "SBX_TEST";
    process.env.ABDM_CLIENT_SECRET = "secret";
    process.env.ABDM_CM_ID = "sbx";
    calls = [];
    now = 1_000_000;
    answer = (call) => {
        if (call.path.endsWith("/profile/login/request/otp") || call.path.endsWith("/phr/web/login/abha/request/otp")) {
            return { txnId: "txn-login", message: "OTP sent to mobile number ending with ******0903" };
        }
        if (call.path.endsWith("/profile/login/verify")) {
            return { txnId: "txn-login", authResult: "success", message: "OTP verified successfully", token: X_TOKEN, refreshToken: "r", expiresIn: 1800, accounts: [{ ABHANumber: ABHA_NUMBER }] };
        }
        if (call.path.endsWith("/profile/account")) return accountProfile;
        throw new Error(`unexpected call ${call.path}`);
    };
    const sessions = new AbhaSessionStore(() => now);
    service = new AbhaLoginService({ findPatientByAbhaNumber: async () => null }, sessions, gateway, fakeCrypto, () => now);
});

test("an ABHA number login sends the dashed number encrypted, with the chosen OTP system", async () => {
    await service.requestLoginOtp({ method: "abha-number", identifier: "91111122223333", otpSystem: "aadhaar", staffUserId: STAFF });
    assert.deepEqual(calls[0]!.body, { scope: ["abha-login", "aadhaar-verify"], loginHint: "abha-number", loginId: `enc(${ABHA_NUMBER})`, otpSystem: "aadhaar" });

    await service.requestLoginOtp({ method: "abha-number", identifier: ABHA_NUMBER, otpSystem: "abdm", staffUserId: STAFF });
    assert.deepEqual(calls[1]!.body, { scope: ["abha-login", "mobile-verify"], loginHint: "abha-number", loginId: `enc(${ABHA_NUMBER})`, otpSystem: "abdm" });

    await assert.rejects(service.requestLoginOtp({ method: "abha-number", identifier: "1234", staffUserId: STAFF }), (error: unknown) => error instanceof AbhaJourneyError && error.status === 400);
});

test("an Aadhaar login always uses the Aadhaar OTP", async () => {
    await service.requestLoginOtp({ method: "aadhaar", identifier: "123412341234", otpSystem: "abdm", staffUserId: STAFF });
    assert.deepEqual(calls[0]!.body, { scope: ["abha-login", "aadhaar-verify"], loginHint: "aadhaar", loginId: "enc(123412341234)", otpSystem: "aadhaar" });
    await assert.rejects(service.requestLoginOtp({ method: "aadhaar", identifier: "12341234", staffUserId: STAFF }), (error: unknown) => error instanceof AbhaJourneyError && error.message === "Aadhaar Number is not valid");
});

test("an ABHA address offers only the methods ABDM lists, and logs in through the PHR API", async () => {
    answer = ((normal) => (call: AbdmCall) => call.path.endsWith("/phr/web/login/abha/search")
        ? { abhaAddress: "asha@sbx", authMethods: ["MOBILE_OTP", "AADHAAR_OTP", "PASSWORD"], blockedAuthMethods: ["AADHAAR_OTP"], fullName: "Asha" }
        : call.path.endsWith("/phr/web/login/abha/verify")
            ? { authResult: "success", message: "OTP verified successfully", token: X_TOKEN, refreshToken: "r", abhaNumber: ABHA_NUMBER }
            : call.path.endsWith("/phr/web/login/profile/abha-profile")
                ? { abhaAddress: "asha@sbx", abhaNumber: ABHA_NUMBER, firstName: "Asha", lastName: "K", dateOfBirth: "05-08-1990", gender: "F", pinCode: "411001", kycStatus: "VERIFIED" }
                : normal(call))(answer);

    const search = await service.searchAbhaAddress({ abhaAddress: "asha" });
    assert.deepEqual(calls[0]!.body, { abhaAddress: "asha@sbx" });
    assert.deepEqual(search.otpSystems, ["abdm"], "blocked and non-OTP methods are not offered");

    const { sessionId } = await service.requestLoginOtp({ method: "abha-address", identifier: "asha@sbx", otpSystem: "abdm", staffUserId: STAFF });
    assert.equal(calls[1]!.path, "/abha/api/v3/phr/web/login/abha/request/otp");
    assert.deepEqual(calls[1]!.body, { scope: ["abha-address-login", "mobile-verify"], loginHint: "abha-address", loginId: "enc(asha@sbx)", otpSystem: "abdm" });

    const result = await service.verifyLoginOtp({ sessionId, staffUserId: STAFF, otp: "123456" });
    assert.equal(result.status, "verified");
    if (result.status !== "verified") return;
    assert.equal(calls.at(-1)!.path, "/abha/api/v3/phr/web/login/profile/abha-profile");
    assert.equal(calls.at(-1)!.headers?.["X-token"], `Bearer ${X_TOKEN}`);
    assert.equal(result.canUpdateMobile, false);
    assert.equal(result.profile.dateOfBirth, "05-08-1990");
    assert.equal(result.profile.kycVerified, true);
});

test("a login answer with a refresh token is final: the profile is read with it", async () => {
    const { sessionId } = await service.requestLoginOtp({ method: "aadhaar", identifier: "123412341234", staffUserId: STAFF });
    const result = await service.verifyLoginOtp({ sessionId, staffUserId: STAFF, otp: "123456" });

    assert.deepEqual(calls[1]!.body, { scope: ["abha-login", "aadhaar-verify"], authData: { authMethods: ["otp"], otp: { txnId: "txn-login", otpValue: "enc(123456)" } } });
    assert.equal(calls[2]!.path, "/abha/api/v3/profile/account");
    assert.equal(calls[2]!.headers?.["X-token"], `Bearer ${X_TOKEN}`);
    assert.ok(!calls.some((call) => call.path.endsWith("/verify/user")), "no account exchange when the token is final");
    assert.equal(result.status, "verified");
    if (result.status === "verified") {
        assert.equal(result.abhaNumber, ABHA_NUMBER);
        assert.equal(result.abhaAddress, "asha.kumari@sbx");
        assert.equal(result.profile.dateOfBirth, "05-08-1990");
    }
    assert.ok(!JSON.stringify(result).includes(X_TOKEN));
});

test("a short-lived token is exchanged at verify/user, after a choice when there are several accounts", async () => {
    const two = [{ ABHANumber: ABHA_NUMBER, name: "Asha" }, { ABHANumber: "91-4444-5555-6666", name: "Ravi" }];
    answer = ((normal) => (call: AbdmCall) => call.path.endsWith("/profile/login/verify")
        ? { txnId: "txn-login", authResult: "success", token: T_TOKEN, accounts: two }
        : call.path.endsWith("/profile/login/verify/user")
            ? { token: X_TOKEN, expiresIn: 1800, refreshToken: "r" }
            : normal(call))(answer);

    const { sessionId } = await service.requestLoginOtp({ method: "abha-number", identifier: ABHA_NUMBER, otpSystem: "abdm", staffUserId: STAFF });
    const first = await service.verifyLoginOtp({ sessionId, staffUserId: STAFF, otp: "123456" });
    assert.equal(first.status, "choose-account");
    assert.ok(!JSON.stringify(first).includes(T_TOKEN));

    await assert.rejects(service.selectAccount({ sessionId, staffUserId: STAFF, abhaNumber: "91-0000-0000-0000" }), (error: unknown) => error instanceof AbhaJourneyError);
    const chosen = await service.selectAccount({ sessionId, staffUserId: STAFF, abhaNumber: "91-4444-5555-6666" });
    const exchange = calls.find((call) => call.path.endsWith("/verify/user"))!;
    assert.equal(exchange.headers?.["T-token"], `Bearer ${T_TOKEN}`);
    assert.deepEqual(exchange.body, { ABHANumber: "91-4444-5555-6666", txnId: "txn-login" });
    assert.equal(chosen.status, "verified");
});

test("one account behind a short-lived token is exchanged without asking", async () => {
    answer = ((normal) => (call: AbdmCall) => call.path.endsWith("/profile/login/verify")
        ? { txnId: "txn-login", authResult: "success", token: T_TOKEN, accounts: [{ ABHANumber: ABHA_NUMBER }] }
        : call.path.endsWith("/profile/login/verify/user") ? { token: X_TOKEN, refreshToken: "r" } : normal(call))(answer);
    const { sessionId } = await service.requestLoginOtp({ method: "abha-number", identifier: ABHA_NUMBER, otpSystem: "abdm", staffUserId: STAFF });
    const result = await service.verifyLoginOtp({ sessionId, staffUserId: STAFF, otp: "123456" });
    assert.equal(result.status, "verified");
    assert.ok(calls.some((call) => call.path.endsWith("/verify/user")));
});

test("nobody holds an ABHA: ABDM-1114 reaches the desk unchanged", async () => {
    const notFound = new AbdmApiError({ status: 404, kind: "rejected", operation: "login/verify", code: "ABDM-1114", message: "No ABHA user registered with this Aadhaar number." });
    answer = ((normal) => (call: AbdmCall) => call.path.endsWith("/profile/login/verify") ? notFound : normal(call))(answer);
    const { sessionId } = await service.requestLoginOtp({ method: "aadhaar", identifier: "123412341234", staffUserId: STAFF });
    await assert.rejects(service.verifyLoginOtp({ sessionId, staffUserId: STAFF, otp: "123456" }), (error: unknown) => error === notFound);
});

test("find by mobile lists accounts, then sends the OTP only for the chosen one", async () => {
    answer = ((normal) => (call: AbdmCall) => call.path.endsWith("/profile/account/abha/search")
        ? [{ txnId: "txn-search", ABHA: [{ index: 1, ABHANumber: "xx-xxxx-xxxx-3333", name: "Asha", gender: "F", authMethods: ["MOBILE_OTP"] }, { index: 2, ABHANumber: "xx-xxxx-xxxx-6666", name: "Ravi", gender: "M" }] }]
        : normal(call))(answer);

    await assert.rejects(service.findByMobile({ mobile: "98765", staffUserId: STAFF }), (error: unknown) => error instanceof AbhaJourneyError && error.message === "Please enter a valid mobile number.");
    const found = await service.findByMobile({ mobile: "9876540903", staffUserId: STAFF });
    assert.deepEqual(calls[0]!.body, { scope: ["search-abha"], mobile: "enc(9876540903)" });
    assert.equal(found.accounts.length, 2);
    assert.equal(calls.length, 1, "no OTP before a choice");

    await service.requestFindOtp({ sessionId: found.sessionId!, staffUserId: STAFF, index: 2 });
    assert.deepEqual(calls[1]!.body, { scope: ["abha-login", "search-abha", "mobile-verify"], loginHint: "index", loginId: "enc(2)", otpSystem: "abdm", txnId: "txn-search" });

    const result = await service.verifyLoginOtp({ sessionId: found.sessionId!, staffUserId: STAFF, otp: "123456" });
    assert.deepEqual((calls[2]!.body as any).scope, ["abha-login", "mobile-verify"]);
    assert.equal(result.status, "verified");
});

test("a mobile with no ABHA is an empty answer, not an error", async () => {
    answer = () => new AbdmApiError({ status: 404, kind: "rejected", operation: "search", message: "ABHA not found" });
    const found = await service.findByMobile({ mobile: "9876540903", staffUserId: STAFF });
    assert.deepEqual(found, { sessionId: null, accounts: [] });
});

test("a login OTP resend reuses the transaction and stops after two", async () => {
    const { sessionId } = await service.requestLoginOtp({ method: "aadhaar", identifier: "123412341234", staffUserId: STAFF });
    await assert.rejects(service.resendLoginOtp({ sessionId, staffUserId: STAFF }), (error: unknown) => error instanceof AbhaJourneyError && error.kind === "resend-wait");
    now += 60_000;
    await service.resendLoginOtp({ sessionId, staffUserId: STAFF });
    assert.equal((calls[1]!.body as any).txnId, "txn-login");
    now += 60_000;
    await service.resendLoginOtp({ sessionId, staffUserId: STAFF });
    now += 60_000;
    await assert.rejects(service.resendLoginOtp({ sessionId, staffUserId: STAFF }), (error: unknown) => error instanceof AbhaJourneyError && error.message === RESEND_LIMIT_MESSAGE);
    assert.equal(calls.length, 3);
});

test("the profile mobile is updated with the user token, after an OTP to the new number", async () => {
    answer = ((normal) => (call: AbdmCall) => call.path.endsWith("/profile/account/request/otp")
        ? { txnId: "txn-mobile", message: "OTP sent" }
        : call.path.endsWith("/profile/account/verify")
            ? { txnId: "txn-mobile", authResult: "success", message: "Mobile Number linked successfully" }
            : normal(call))(answer);
    const { sessionId } = await service.requestLoginOtp({ method: "aadhaar", identifier: "123412341234", staffUserId: STAFF });
    await service.verifyLoginOtp({ sessionId, staffUserId: STAFF, otp: "123456" });

    await service.requestProfileMobileOtp({ sessionId, staffUserId: STAFF, mobile: "9000011111" });
    const request = calls.at(-1)!;
    assert.equal(request.headers?.["X-token"], `Bearer ${X_TOKEN}`);
    assert.deepEqual(request.body, { scope: ["abha-profile", "mobile-verify"], loginHint: "mobile", loginId: "enc(9000011111)", otpSystem: "abdm" });

    const updated = await service.verifyProfileMobileOtp({ sessionId, staffUserId: STAFF, otp: "654321" });
    assert.deepEqual(calls.at(-1)!.body, { scope: ["abha-profile", "mobile-verify"], authData: { authMethods: ["otp"], otp: { txnId: "txn-mobile", otpValue: "enc(654321)" } } });
    assert.equal(updated.updated, true);
});

test("identifiers normalise the way ABDM validates them", () => {
    assert.equal(normalizeAbhaNumber("91 1111 2222 3333"), ABHA_NUMBER);
    assert.equal(normalizeAbhaNumber("91-1111-2222-333"), null);
    assert.equal(normalizeAbhaNumber("91-1111-2222-333a"), null);
    assert.equal(normalizeAbhaAddress("Asha.K", "@sbx"), "asha.k@sbx");
    assert.equal(normalizeAbhaAddress("asha@abdm", "@sbx"), "asha@abdm");
    assert.equal(normalizeAbhaAddress("as ha", "@sbx"), null);
});
