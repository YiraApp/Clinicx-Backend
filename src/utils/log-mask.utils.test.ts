import { test } from "node:test";
import assert from "node:assert/strict";
import { headersForLog, maskCredentials, maskHeadersForLog, maskRequestBodyForLog, maskResponseForLog } from "./log-mask.utils.js";

test("ABDM request bodies lose the Aadhaar number, OTPs and mobiles, at any depth", () => {
    const masked = maskRequestBodyForLog("/api/abdm/enrolment/verify", {
        sessionId: "session-1",
        aadhaar: "123412341234",
        otp: "123456",
        mobile: "9876543210",
        nested: { otp: "654321", keep: "yes" },
    });
    assert.deepEqual(masked, {
        sessionId: "session-1",
        aadhaar: "********",
        otp: "********",
        mobile: "********",
        nested: { otp: "********", keep: "yes" },
    });
});

test("a verify-by-Aadhaar body never logs the Aadhaar it carries as the identifier", () => {
    assert.deepEqual(maskRequestBodyForLog("/api/abdm/login/otp", { method: "aadhaar", identifier: "123412341234", otpSystem: "aadhaar" }), {
        method: "aadhaar",
        identifier: "********",
        otpSystem: "aadhaar",
    });
});

test("other routes keep their bodies, with passwords masked as before", () => {
    assert.deepEqual(maskRequestBodyForLog("/api/auth/login", { email: "a@b.c", password: "pw", mobile: "9876543210" }), {
        email: "a@b.c",
        password: "********",
        mobile: "9876543210",
    });
});

test("ABDM responses keep status, message and error details only", () => {
    const success = JSON.stringify({ status: true, message: "This account already exist", data: { abhaNumber: "91-1111-2222-3333", profile: { photo: "base64" } } });
    assert.equal(maskResponseForLog("/api/abdm/enrolment/verify", success), JSON.stringify({ status: true, message: "This account already exist" }));

    const failure = JSON.stringify({
        status: false,
        message: "ABDM did not accept this request.",
        data: { kind: "rejected", abdmMessage: "UIDAI Error code : 400 : Invalid Aadhaar OTP value.", abdmCode: "ABDM-1204", field: null, requestId: "r-1", hint: null },
    });
    assert.deepEqual(JSON.parse(maskResponseForLog("/api/abdm/enrolment/verify", failure)), {
        status: false,
        message: "ABDM did not accept this request.",
        data: { kind: "rejected", abdmCode: "ABDM-1204", abdmMessage: "UIDAI Error code : 400 : Invalid Aadhaar OTP value.", field: null, requestId: "r-1" },
    });

    assert.equal(maskResponseForLog("/api/abdm/enrolment/card", "not json"), "[ABDM response not logged]");
    assert.equal(maskResponseForLog("/api/patients", success), success);
});

test("M3 record-request fields are masked on the ABDM routes, at any depth, arrays included", () => {
    const masked = maskRequestBodyForLog("/api/abdm/hiu/consent-requests", {
        patientUserId: "11111111-1111-1111-1111-111111111111",
        abhaAddress: "someone@sbx",
        patientName: "A Patient",
        purposeCode: "CAREMGT",
        hiTypes: ["Prescription"],
        nested: {
            patientReference: "PR-1",
            careContextReference: "CC-1",
            careContexts: [{ careContextReference: "CC-2" }],
            entries: [{ content: "cipher", checksum: "abc" }],
            keyMaterial: { dhPublicKey: { keyValue: "MIIB..." }, nonce: "n0nce" },
            privateKey: "secret",
            dataPushUrl: "https://host/api/v3/hiu/data-push/token",
        },
    });
    assert.deepEqual(masked, {
        patientUserId: "11111111-1111-1111-1111-111111111111",
        abhaAddress: "********",
        patientName: "********",
        purposeCode: "CAREMGT",
        hiTypes: ["Prescription"],
        nested: {
            patientReference: "********",
            careContextReference: "********",
            careContexts: "********",
            entries: [{ content: "********", checksum: "abc" }],
            keyMaterial: { dhPublicKey: { keyValue: "********" }, nonce: "********" },
            privateKey: "********",
            dataPushUrl: "********",
        },
    });
});

test("a decrypted record in an HIU response is never logged", () => {
    const records = JSON.stringify({ status: true, message: "Success", data: { available: true, records: [{ bundle: { resourceType: "Bundle" }, raw: null }] } });
    assert.equal(maskResponseForLog("/api/abdm/hiu/artefacts/7/records", records), JSON.stringify({ status: true, message: "Success" }));
});

test("the API log keeps every request header except Authorization", () => {
    assert.deepEqual(headersForLog({ authorization: "Bearer jwt", "x-hospital-id": "3", "user-agent": "ua" }), { "x-hospital-id": "3", "user-agent": "ua" });
    assert.deepEqual(headersForLog({ Authorization: "Bearer jwt" }), {});
});

test("ABDM callback bodies are not logged; they are stored in AbdmExchanges", () => {
    const logged = JSON.stringify(maskRequestBodyForLog("/api/v3/hip/patient/care-context/discover", {
        patient: { name: "Test Patient", verifiedIdentifiers: [{ type: "MOBILE", value: "+919800000000" }] },
    }));
    assert.ok(!logged.includes("Test Patient"));
    assert.ok(!logged.includes("+919800000000"));
});

test("credential headers are masked on every route, and other headers are kept", () => {
    const headers = { authorization: "Bearer abc", "x-link-token": "xyz", "x-hip-id": "IN0000000001" };
    assert.deepEqual(maskHeadersForLog("/api/v3/link/on_carecontext", headers), { authorization: "********", "x-link-token": "********", "x-hip-id": "IN0000000001" });
    assert.deepEqual(maskHeadersForLog("/api/abdm/bridge", headers).authorization, "********");
    assert.deepEqual(maskHeadersForLog("/api/patients", headers), { authorization: "********", "x-link-token": "********", "x-hip-id": "IN0000000001" });
});

test("stored ABDM bodies lose credentials but keep their shape", () => {
    assert.deepEqual(maskCredentials({ abhaAddress: "a@sbx", linkToken: "secret", response: { requestId: "r1" } }), {
        abhaAddress: "a@sbx",
        linkToken: "********",
        response: { requestId: "r1" },
    });
});

test("a refused ABDM callback keeps our own refusal message in the log", () => {
    const logged = maskResponseForLog("/api/v3/hip/token/on-generate-token", JSON.stringify({ error: { message: 'This call came from ABDM client "gateway"' } }));
    assert.deepEqual(JSON.parse(logged).error, { message: 'This call came from ABDM client "gateway"' });
});
