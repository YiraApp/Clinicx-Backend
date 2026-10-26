import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AbdmApiError, AbdmGatewayService, abdmTimestamp, normalizeAbdmCode, parseAbdmError } from "./abdm-gateway.service.js";

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = "client-secret-never-logged";
const GATEWAY_TOKEN = "gateway-token-never-logged";

interface Recorded {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: any;
}

const realFetch = globalThis.fetch;
const realConsole = { log: console.log, warn: console.warn, error: console.error };
let calls: Recorded[];
let logged: string[];

const stubFetch = (answer: (request: Recorded) => { status: number; body?: unknown }) => {
    globalThis.fetch = (async (url: any, init: any) => {
        const request: Recorded = {
            url: String(url),
            method: init.method,
            headers: init.headers,
            body: init.body ? JSON.parse(init.body) : undefined,
        };
        calls.push(request);
        const { status, body } = answer(request);
        const payload = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
        return new Response(payload, { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
};

const isSessionCall = (request: Recorded) => request.url.endsWith("/api/hiecm/gateway/v3/sessions");
const sessionAnswer = { status: 202, body: { accessToken: GATEWAY_TOKEN, expiresIn: 1200, tokenType: "bearer" } };

beforeEach(() => {
    calls = [];
    logged = [];
    process.env.ABDM_CLIENT_ID = "SBX_TEST";
    process.env.ABDM_CLIENT_SECRET = SECRET;
    for (const level of ["log", "warn", "error"] as const) {
        console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    }
});

afterEach(() => {
    globalThis.fetch = realFetch;
    Object.assign(console, realConsole);
});

test("the session call carries REQUEST-ID, TIMESTAMP and X-CM-ID, and no Authorization", async () => {
    stubFetch((request) => (isSessionCall(request) ? sessionAnswer : { status: 200, body: { ok: true } }));
    const gateway = new AbdmGatewayService();

    await gateway.call({ operation: "test", method: "GET", path: "/abha/api/v3/profile/public/certificate" });

    const [session, call] = calls;
    assert.ok(session && call);
    assert.ok(isSessionCall(session));
    assert.match(session.headers["REQUEST-ID"]!, UUID);
    assert.match(session.headers.TIMESTAMP!, TIMESTAMP);
    assert.equal(session.headers["X-CM-ID"], "sbx");
    assert.equal(session.headers.Authorization, undefined);
    assert.deepEqual(session.body, { clientId: "SBX_TEST", clientSecret: SECRET, grantType: "client_credentials" });

    assert.equal(call.url, "https://abhasbx.abdm.gov.in/abha/api/v3/profile/public/certificate");
    assert.equal(call.headers.Authorization, `Bearer ${GATEWAY_TOKEN}`);
    assert.match(call.headers.TIMESTAMP!, TIMESTAMP);
    assert.match(call.headers["REQUEST-ID"]!, UUID);
    assert.notEqual(call.headers["REQUEST-ID"], session.headers["REQUEST-ID"], "every call gets a fresh REQUEST-ID");
});

test("the gateway token is reused until a minute before it expires", async () => {
    let now = 1_000_000;
    stubFetch((request) => (isSessionCall(request) ? sessionAnswer : { status: 200, body: {} }));
    const gateway = new AbdmGatewayService(() => now);
    const call = () => gateway.call({ operation: "test", method: "GET", path: "/abha/api/v3/x" });

    await call();
    await call();
    assert.equal(calls.filter(isSessionCall).length, 1);

    now += (1200 - 60) * 1000;
    await call();
    assert.equal(calls.filter(isSessionCall).length, 2);
});

test("a credentials refusal clears the token and is not retried", async () => {
    stubFetch((request) => (isSessionCall(request) ? sessionAnswer : { status: 401, body: { code: "900901", message: "Invalid Credentials" } }));
    const gateway = new AbdmGatewayService();

    await assert.rejects(
        gateway.call({ operation: "test", method: "POST", path: "/abha/api/v3/x", body: {} }),
        (error: unknown) => error instanceof AbdmApiError && error.kind === "credentials" && error.code === "900901",
    );
    assert.equal(calls.length, 2, "one session call and one refused call, no retry");

    await assert.rejects(gateway.call({ operation: "test", method: "POST", path: "/abha/api/v3/x", body: {} }));
    assert.equal(calls.filter(isSessionCall).length, 2, "the next call starts a new session");
});

test("an expired user token is the journey's problem, not the clinic's credentials", async () => {
    stubFetch((request) => (isSessionCall(request) ? sessionAnswer : { status: 401, body: { message: "X-token expired", timestamp: "2024-05-10T18:52:59.000Z" } }));
    const gateway = new AbdmGatewayService();

    await assert.rejects(
        gateway.call({ operation: "test", method: "GET", path: "/abha/api/v3/profile/account/abha-card" }),
        (error: unknown) => error instanceof AbdmApiError && error.kind === "rejected" && error.message === "X-token expired",
    );
});

test("an ABDM business code on a 401 refuses the journey and keeps the gateway token", async () => {
    stubFetch((request) => (isSessionCall(request) ? sessionAnswer : { status: 401, body: { error: { code: "ABDM-1017", message: "Invalid Transaction Id" } } }));
    const gateway = new AbdmGatewayService();
    const call = () => gateway.call({ operation: "test", method: "GET", path: "/abha/api/v3/enrollment/enrol/suggestion" });

    await assert.rejects(call(), (error: unknown) => error instanceof AbdmApiError && error.kind === "rejected" && error.code === "ABDM-1017");
    await assert.rejects(call());
    assert.equal(calls.filter(isSessionCall).length, 1, "the gateway token was not thrown away");
});

test("a refusal without a body still becomes a readable error", async () => {
    stubFetch((request) => (isSessionCall(request) ? sessionAnswer : { status: 500 }));
    const gateway = new AbdmGatewayService();

    await assert.rejects(
        gateway.call({ operation: "test", method: "GET", path: "/abha/api/v3/x" }),
        (error: unknown) => error instanceof AbdmApiError && error.kind === "unavailable" && /HTTP 500/.test(error.message),
    );
});

test("nothing is sent when ABDM credentials are not configured", async () => {
    delete process.env.ABDM_CLIENT_SECRET;
    stubFetch(() => sessionAnswer);
    const gateway = new AbdmGatewayService();

    await assert.rejects(
        gateway.call({ operation: "test", method: "GET", path: "/abha/api/v3/x" }),
        (error: unknown) => error instanceof AbdmApiError && error.kind === "not-configured",
    );
    assert.equal(calls.length, 0);
});

test("logs never carry the client secret or a token", async () => {
    stubFetch((request) => (isSessionCall(request) ? sessionAnswer : { status: 422, body: { error: { code: "ABDM-1204", message: "UIDAI Error code : 400 : Invalid Aadhaar OTP value." } } }));
    const gateway = new AbdmGatewayService();

    await assert.rejects(gateway.call({ operation: "test", method: "POST", path: "/abha/api/v3/x", body: { otpValue: "ciphertext" } }));

    const everything = logged.join("\n");
    assert.ok(logged.length > 0);
    assert.ok(!everything.includes(SECRET));
    assert.ok(!everything.includes(GATEWAY_TOKEN));
    assert.ok(!everything.includes("ciphertext"), "request bodies are not logged");
    assert.match(everything, /REQUEST-ID=/);
});

test("a caller's REQUEST-ID is sent and logged; without one each call gets a fresh UUID", async () => {
    const ours = "6f1c2a3b-0d4e-4f5a-8b9c-0123456789ab";
    stubFetch((request) => (isSessionCall(request) ? sessionAnswer : { status: 422, body: { error: { code: "ABDM-1040", message: "Invalid HIU ID" } } }));
    const gateway = new AbdmGatewayService();

    await assert.rejects(
        gateway.call({ operation: "consent/request/init", method: "POST", host: "gateway", path: "/api/hiecm/consent/v3/request/init", body: {}, requestId: ours }),
        (error: unknown) => error instanceof AbdmApiError && error.requestId === ours && error.code === "ABDM-1040",
    );
    const [session, call] = calls;
    assert.ok(session && call);
    assert.equal(call.headers["REQUEST-ID"], ours);
    assert.equal(call.headers["X-CM-ID"], "sbx");
    assert.match(call.headers.TIMESTAMP!, TIMESTAMP);
    assert.notEqual(session.headers["REQUEST-ID"], ours, "the session call keeps its own REQUEST-ID");
    assert.ok(logged.some((line) => line.includes(`REQUEST-ID=${ours} -> 422`)));
    assert.ok(logged.some((line) => line.includes(`REQUEST-ID=${ours} refused`)));

    calls = [];
    await assert.rejects(gateway.call({ operation: "test", method: "POST", host: "gateway", path: "/api/hiecm/x", body: {} }));
    assert.match(calls[0]!.headers["REQUEST-ID"]!, UUID);
    assert.notEqual(calls[0]!.headers["REQUEST-ID"], ours);
});

test("ABDM's error shapes all parse", () => {
    assert.deepEqual(parseAbdmError(422, { error: { code: "ABDM-1204: ", message: "UIDAI Error code : 400 : Invalid Aadhaar OTP value." } }), {
        code: "ABDM-1204",
        message: "UIDAI Error code : 400 : Invalid Aadhaar OTP value.",
        field: null,
    });
    assert.deepEqual(parseAbdmError(401, { code: "900901", message: "Invalid Credentials", description: "Invalid JWT token." }), {
        code: "900901",
        message: "Invalid Credentials",
        field: null,
    });
    assert.deepEqual(parseAbdmError(400, { loginId: "Invalid LoginId", timestamp: "2024-05-10T11:15:14.000Z" }), {
        code: null,
        message: "Invalid LoginId",
        field: "loginId",
    });
    // A wrong mobile OTP on enrollment/auth/byAbdm names no field: the description is the message, not the txnId.
    assert.deepEqual(parseAbdmError(400, { txnId: "30839193-9788-4c0d-9459-7cd70a", description: "Invalid OTP value" }), {
        code: null,
        message: "Invalid OTP value",
        field: null,
    });
    assert.deepEqual(parseAbdmError(400, [{ error: { code: "ABDM-1002: ", message: "Invalid HIP ID" } }]), {
        code: "ABDM-1002",
        message: "Invalid HIP ID",
        field: null,
    });
    assert.equal(parseAbdmError(400, null).message, "ABDM answered with HTTP 400 and no message.");
    assert.equal(normalizeAbdmCode("ABDM-1114: "), "ABDM-1114");
    assert.equal(normalizeAbdmCode("ABDM-1114"), "ABDM-1114");
});

test("TIMESTAMP is UTC ISO-8601 with milliseconds and Z", () => {
    assert.equal(abdmTimestamp(new Date(Date.UTC(2022, 9, 6, 15, 10, 0, 587))), "2022-10-06T15:10:00.587Z");
});
