import { test } from "node:test";
import assert from "node:assert/strict";
import { maskRequestBodyForLog, maskResponseForLog } from "./log-mask.utils.js";

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
