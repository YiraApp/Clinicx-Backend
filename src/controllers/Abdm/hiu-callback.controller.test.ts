import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createSign, generateKeyPairSync } from "node:crypto";
import express from "express";
import { AbdmCallbackAuth, CallbackAuthError, type CallbackVerifyOptions } from "../../services/Abdm/abdm-callback-auth.service.js";
import { callbackSummary, createHiuCallbackController, pushAuthRefusalReason, type HiuCallbackServices } from "./hiu-callback.controller.js";
import { createHiuCallbackRouter, createHiuDataPushRouter } from "../../routes/Abdm/hiu-callback.routes.js";

const HIU = "IN3610001174";
/** Another hospital's HIU on the same deployment. */
const HIU_B = "IN3610002222";
const hius = new Map([[HIU, { id: HIU, hospitalId: 19, name: "A A Hospital" }], [HIU_B, { id: HIU_B, hospitalId: 20, name: "B B Clinic" }]]);
const hiuLookups: (string | null | undefined)[] = [];
const directory = {
    async hiuById(id: string | null | undefined) {
        hiuLookups.push(id);
        return id ? hius.get(id) ?? null : null;
    },
};
const TOKEN = "a".repeat(64);

/** Auth stub: "gateway-token" is ABDM's gateway, "hip-token" a HIP's own token (refused by the pin). */
const authCalls: CallbackVerifyOptions[] = [];
const auth = {
    async verify(authorization: string | undefined, options: CallbackVerifyOptions = {}) {
        authCalls.push(options);
        if (authorization === "Bearer gateway-token") return { clientId: "gateway" };
        if (authorization === "Bearer hip-token") {
            if (options.pinClient === false) return { clientId: "SBX_HIP" };
            throw new CallbackAuthError(`The callback came from ABDM client "SBX_HIP", which is not allowed.`);
        }
        if (authorization === "Bearer forged") throw new CallbackAuthError("The callback token's signature does not match ABDM's key.", "bad-signature");
        throw new CallbackAuthError("The callback carries no bearer token.", "no-token");
    },
};

const calls: { method: string; body: any; headers?: any; token?: string }[] = [];
let pushAnswer = { accepted: true, status: 202 } as { accepted: boolean; status: number; reason?: string };
/** What the push address check answers (null: an open transfer), and the tokens it was asked about. */
let addressAnswer: { accepted: boolean; status: number; reason?: string } | null = null;
const addressChecks: string[] = [];
/** Pushes the route refused before acceptPush, as recorded against their push token (notePushRefused). */
const refusals: { token: string; status: number; reason: string }[] = [];
const services: HiuCallbackServices = {
    consent: {
        onInit: async (body, headers) => { calls.push({ method: "onInit", body, headers }); },
        onStatus: async (body, headers) => { calls.push({ method: "onStatus", body, headers }); },
        notify: async (body, headers) => { calls.push({ method: "notify", body, headers }); },
        onFetch: async (body, headers) => { calls.push({ method: "onFetch", body, headers }); },
    },
    dataFlow: {
        onRequest: async (body, headers) => { calls.push({ method: "onRequest", body, headers }); },
        acceptPush: async (token, body) => { calls.push({ method: "acceptPush", body, token }); return pushAnswer; },
        pushAddressProblem: async (token) => { addressChecks.push(token); return addressAnswer; },
        notePushRefused: async (token, status, reason) => { refusals.push({ token, status, reason }); },
    },
};

// Strict: a push must carry ABDM's token (ABDM_DATA_PUSH_REQUIRE_TOKEN=true). The default is covered on its own below.
const controller = createHiuCallbackController({ auth, services: async () => services, directory, pushTokenGraceMinutes: () => 60, pushRequiresToken: () => true });

// The same order as app.ts: the push router before the global parser, then the callback router.
const app = express();
app.use("/api/v3/hiu/data-push", createHiuDataPushRouter(controller, 0.01)); // ~10 KB limit for the 413 test
app.use(express.json());
app.use("/api/v3/hiu", createHiuCallbackRouter(controller));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const post = async (path: string, headers: Record<string, string>, body: unknown = { response: { requestId: "r-1" } }) => {
    const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    await settle();
    return { status: response.status, text, json: text ? JSON.parse(text) : null };
};

const good = { authorization: "Bearer gateway-token", "REQUEST-ID": "11111111-2222-3333-4444-555555555555", "TIMESTAMP": "2026-10-26T10:00:00.000Z", "X-HIU-ID": HIU };

const CALLBACKS = [
    ["/api/v3/hiu/consent/request/on-init", "onInit"],
    ["/api/v3/hiu/consent/request/on-status", "onStatus"],
    ["/api/v3/hiu/consent/request/notify", "notify"],
    ["/api/v3/hiu/consent/on-fetch", "onFetch"],
    ["/api/v3/hiu/health-information/on-request", "onRequest"],
] as const;

test("each callback is refused before any service call: no bearer, bad signature, wrong client, missing REQUEST-ID, wrong or missing X-HIU-ID", async () => {
    for (const [path] of CALLBACKS) {
        calls.length = 0;
        const { authorization: _a, ...noBearer } = good;
        assert.equal((await post(path, noBearer)).status, 401);
        const forged = await post(path, { ...good, authorization: "Bearer forged" });
        assert.equal(forged.status, 401);
        assert.deepEqual(forged.json, { error: { code: "ABDM-1001", message: "Unauthorized" } });
        assert.equal((await post(path, { ...good, authorization: "Bearer hip-token" })).status, 401, "a HIP's token fails the gateway pin");

        const { "REQUEST-ID": _r, ...noRequestId } = good;
        const missing = await post(path, noRequestId);
        assert.equal(missing.status, 400);
        assert.equal(missing.json.error.code, "ABDM-1006");

        assert.equal((await post(path, { ...good, "X-HIU-ID": "IN0000000000" })).status, 400);
        const { "X-HIU-ID": _h, ...noHiu } = good;
        assert.equal((await post(path, noHiu)).status, 400);
        assert.equal((await post(path, good, [1, 2])).status, 400, "the body must be an object");

        assert.equal(calls.length, 0, `no service call for refused ${path}`);
    }
});

test("a good callback is answered 200 {} and handed to its service with the headers", async () => {
    for (const [path, method] of CALLBACKS) {
        calls.length = 0;
        const answer = await post(path, good, { response: { requestId: "r-9" }, patient: { id: "someone@sbx" } });
        assert.equal(answer.status, 200);
        assert.deepEqual(answer.json, {});
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.method, method);
        assert.deepEqual(calls[0]!.headers, { requestId: good["REQUEST-ID"], hiuId: HIU, timestamp: good.TIMESTAMP });
        assert.equal(calls[0]!.body.response.requestId, "r-9");
    }
});

test("the callbacks check the gateway pin; a service failure after the answer is only logged", async () => {
    authCalls.length = 0;
    const failing = createHiuCallbackController({
        auth,
        directory,
        services: async () => ({ ...services, consent: { ...services.consent, notify: async () => { throw new Error("boom"); } } }),
    });
    const res: any = { statusCode: 0, body: null, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
    const headers = Object.fromEntries(Object.entries(good).map(([k, v]) => [k.toLowerCase(), v]));
    await failing.notify({ headers, body: { notification: {} } } as any, res);
    await settle();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(authCalls, [{}], "the default verify: pinned, the exact bearer, the strict expiry");
});

test("with no hospital set up as an HIU every callback is refused, the old ABDM_HIU_ID included", async () => {
    calls.length = 0;
    const unset = createHiuCallbackController({ auth, services: async () => services, directory: { hiuById: async () => null } });
    const res: any = { statusCode: 0, status(code: number) { this.statusCode = code; return this; }, json() { return this; } };
    for (const hiuId of ["", HIU]) {
        const headers = { authorization: "Bearer gateway-token", "request-id": "r", "x-hiu-id": hiuId };
        await unset.onInit({ headers, body: {} } as any, res);
        assert.equal(res.statusCode, 400);
    }
    assert.equal(calls.length, 0);
});

test("each hospital's HIU is accepted with its own X-HIU-ID, passed on for the service to match against the request", async () => {
    for (const [path, method] of CALLBACKS) {
        calls.length = 0;
        hiuLookups.length = 0;
        const answer = await post(path, { ...good, "X-HIU-ID": HIU_B });
        assert.equal(answer.status, 200);
        assert.deepEqual(hiuLookups, [HIU_B], "X-HIU-ID is checked against the facility directory");
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.method, method);
        assert.equal(calls[0]!.headers.hiuId, HIU_B);
    }
});

test("an X-HIU-ID no hospital acts as is refused 400 ABDM-1006 before any service call", async () => {
    calls.length = 0;
    const unknown = await post("/api/v3/hiu/consent/request/notify", { ...good, "X-HIU-ID": "IN9999999999" });
    assert.equal(unknown.status, 400);
    assert.deepEqual(unknown.json, { error: { code: "ABDM-1006", message: "X-HIU-ID does not name this HIU" } });
    assert.equal(calls.length, 0);
});

test("when the facility directory cannot be read the callback is answered 500, not taken", async () => {
    calls.length = 0;
    const broken = createHiuCallbackController({ auth, services: async () => services, directory: { hiuById: async () => { throw new Error("db down"); } } });
    const res: any = { statusCode: 0, status(code: number) { this.statusCode = code; return this; }, json() { return this; } };
    await broken.notify({ headers: { authorization: "Bearer gateway-token", "request-id": "r", "x-hiu-id": HIU }, body: {} } as any, res);
    assert.equal(res.statusCode, 500);
    await settle();
    assert.equal(calls.length, 0);
});

test("data push: the HIP's own token passes without the client pin, and an accepted page gets 202", async () => {
    calls.length = 0;
    authCalls.length = 0;
    pushAnswer = { accepted: true, status: 202 };
    const page = { pageNumber: 1, pageCount: 1, transactionId: "t-1", entries: [{ content: "x", checksum: "y" }], keyMaterial: { nonce: "n" } };
    const answer = await post(`/api/v3/hiu/data-push/${TOKEN}`, { authorization: "Bearer hip-token" }, page);
    assert.equal(answer.status, 202);
    assert.equal(answer.text, "", "nothing is echoed");
    assert.deepEqual(authCalls, [{ pinClient: false, lenientBearer: true, expiryGraceMs: 60 * 60_000 }], "no pin, a lenient bearer and the grace: the push only");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "acceptPush");
    assert.equal(calls[0]!.token, TOKEN);
    assert.deepEqual(calls[0]!.body, page);
});

test("data push: acceptPush's refusal is passed through as its status, without echoing the body", async () => {
    for (const refusal of [
        { accepted: false, status: 404, reason: "Not found." },
        { accepted: false, status: 410, reason: "The window for this transfer has closed." },
        { accepted: false, status: 409, reason: "This transfer has already ended." },
    ]) {
        pushAnswer = refusal;
        const answer = await post(`/api/v3/hiu/data-push/${TOKEN}`, { authorization: "Bearer hip-token" }, { transactionId: "t-1", secret: "do-not-echo" });
        assert.equal(answer.status, refusal.status);
        assert.deepEqual(answer.json, { error: { code: String(refusal.status), message: refusal.reason } });
        assert.ok(!answer.text.includes("do-not-echo"));
    }
});

test("data push, by default: a push with no ABDM token is admitted by its push address; a token that is sent must still be valid", async () => {
    const lenient = createHiuCallbackController({ auth, services: async () => services, directory, pushTokenGraceMinutes: () => 60, pushRequiresToken: () => false });
    const lenientApp = express();
    lenientApp.use("/api/v3/hiu/data-push", createHiuDataPushRouter(lenient, 1));
    const s = lenientApp.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => s.once("listening", () => resolve()));
    const at = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const page = { pageNumber: 1, pageCount: 1, transactionId: "t-1", entries: [], keyMaterial: { nonce: "n" } };
    const push = async (headers: Record<string, string>) => {
        const response = await fetch(`${at}/api/v3/hiu/data-push/${TOKEN}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(page) });
        await response.text();
        await settle();
        return response.status;
    };
    const originalLog = console.log;
    console.log = () => {};
    try {
        pushAnswer = { accepted: true, status: 202 };
        addressAnswer = null;
        calls.length = 0;
        addressChecks.length = 0;
        refusals.length = 0;
        // No Authorization header, an empty one, or another scheme: no ABDM token, so the push address decides.
        const noToken: Record<string, string>[] = [{}, { authorization: "" }, { authorization: "Basic dXNlcjpwYXNz" }];
        for (const headers of noToken) {
            assert.equal(await push(headers), 202, JSON.stringify(headers));
        }
        assert.equal(calls.length, 3);
        assert.deepEqual(addressChecks, [TOKEN, TOKEN, TOKEN], "each one still passed the push address check");
        // A token that is sent is still checked: a forged one is refused, before the address check.
        addressChecks.length = 0;
        assert.equal(await push({ authorization: "Bearer forged" }), 401);
        assert.deepEqual(addressChecks, []);
        assert.deepEqual(refusals, [{ token: TOKEN, status: 401, reason: "token not signed by ABDM" }]);
        // With no token, an unknown or closed address is still refused.
        addressAnswer = { accepted: false, status: 404, reason: "Not found." };
        assert.equal(await push({}), 404);
    } finally {
        console.log = originalLog;
        addressAnswer = null;
        s.close();
    }
});

test("data push: no bearer or a forged one is refused before the body is read or acceptPush runs, and recorded against the push token", async () => {
    calls.length = 0;
    refusals.length = 0;
    addressChecks.length = 0;
    assert.equal((await post(`/api/v3/hiu/data-push/${TOKEN}`, {}, { transactionId: "t" })).status, 401);
    assert.equal((await post(`/api/v3/hiu/data-push/${TOKEN}`, { authorization: "Bearer forged" }, { transactionId: "t" })).status, 401);
    assert.equal(calls.length, 0);
    assert.deepEqual(addressChecks, [], "the push address check (and the body) never ran");
    assert.deepEqual(refusals, [
        { token: TOKEN, status: 401, reason: "no bearer token" },
        { token: TOKEN, status: 401, reason: "token not signed by ABDM" },
    ]);
});

test("data push: a body over ABDM_DATA_PUSH_MAX_MB gets a JSON 413, and broken JSON a JSON 400, each recorded against the push token", async () => {
    calls.length = 0;
    refusals.length = 0;
    const big = await post(`/api/v3/hiu/data-push/${TOKEN}`, { authorization: "Bearer hip-token" }, { entries: [{ content: "x".repeat(20_000) }] });
    assert.equal(big.status, 413);
    assert.equal(big.json.error.code, "413");
    const broken = await post(`/api/v3/hiu/data-push/${TOKEN}`, { authorization: "Bearer hip-token" }, "{not json");
    assert.equal(broken.status, 400);
    assert.deepEqual(broken.json, { error: { code: "400", message: "The body is not valid JSON." } });
    assert.equal(calls.length, 0);
    assert.deepEqual(refusals, [
        { token: TOKEN, status: 413, reason: "page too large (over 0.01 MB)" },
        { token: TOKEN, status: 400, reason: "not JSON" },
    ]);
});

test("data push: the page is parsed as JSON whatever its Content-Type, or none; a body that is not JSON is still 400", async () => {
    pushAnswer = { accepted: true, status: 202 };
    const page = { pageNumber: 1, pageCount: 1, transactionId: "t-1", entries: [], keyMaterial: { nonce: "n" } };
    const send = (contentType: string | null, body: string | ArrayBuffer) => fetch(`${base}/api/v3/hiu/data-push/${TOKEN}`, {
        method: "POST",
        headers: { authorization: "Bearer hip-token", ...(contentType ? { "Content-Type": contentType } : {}) },
        body,
    });
    for (const contentType of ["application/json", "text/plain", "application/x-www-form-urlencoded", "application/octet-stream", "application/json; charset=ISO-8859-1", "application/fhir+json", null]) {
        calls.length = 0;
        const response = await send(contentType, contentType ? JSON.stringify(page) : new TextEncoder().encode(JSON.stringify(page)).buffer as ArrayBuffer);
        assert.equal(response.status, 202, String(contentType));
        assert.equal(calls.length, 1, String(contentType));
        assert.deepEqual(calls[0]!.body, page, String(contentType));
    }
    // A leading byte-order mark is dropped.
    calls.length = 0;
    assert.equal((await send("application/json", `\uFEFF${JSON.stringify(page)}`)).status, 202);
    assert.deepEqual(calls[0]!.body, page);

    // A body declared UTF-16 is read as UTF-16, as express.json read it (with or without its byte-order mark).
    const utf16le = (text: string, bom: boolean) => {
        const bytes = Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, "utf16le")]);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    };
    for (const [contentType, bom] of [["application/json; charset=utf-16le", false], ["application/json; charset=UTF-16", true]] as const) {
        calls.length = 0;
        const response = await send(contentType, utf16le(JSON.stringify(page), bom));
        assert.equal(response.status, 202, contentType);
        assert.deepEqual(calls[0]!.body, page, contentType);
    }

    calls.length = 0;
    refusals.length = 0;
    const broken = await send("text/plain", "transactionId=t-1&pageNumber=1");
    assert.equal(broken.status, 400);
    assert.deepEqual(await broken.json(), { error: { code: "400", message: "The body is not valid JSON." } });
    await settle();
    assert.equal(calls.length, 0);
    assert.deepEqual(refusals, [{ token: TOKEN, status: 400, reason: "not JSON" }]);
});

test("data push with ABDM's real token check: a lenient bearer and the grace for the push only; gateway callbacks stay strict", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "gw-key-1", alg: "RS256", use: "sig" };
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const sign = (claims: object, header: object = { alg: "RS256", typ: "JWT", kid: "gw-key-1" }) => {
        const head = `${b64(header)}.${b64(claims)}`;
        return `${head}.${createSign("RSA-SHA256").update(head).sign(privateKey).toString("base64url")}`;
    };
    const clock = Date.now();
    const seconds = (minutesFromNow: number) => Math.floor(clock / 1000) + minutesFromNow * 60;
    const realAuth = new AbdmCallbackAuth({ async call<T>(): Promise<T> { return { keys: [jwk] } as T; } }, () => clock, { callbackClientIds: async () => ["gateway"] });
    const real = createHiuCallbackController({ auth: realAuth, services: async () => services, directory, pushTokenGraceMinutes: () => 60, pushRequiresToken: () => true });
    const realApp = express();
    realApp.use("/api/v3/hiu/data-push", createHiuDataPushRouter(real, 1));
    realApp.use(express.json());
    realApp.use("/api/v3/hiu", createHiuCallbackRouter(real));
    const s = realApp.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => s.once("listening", () => resolve()));
    const at = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const page = { pageNumber: 1, pageCount: 1, transactionId: "t-1", entries: [], keyMaterial: { nonce: "n" } };
    const push = async (authorization: string) => {
        const response = await fetch(`${at}/api/v3/hiu/data-push/${TOKEN}`, { method: "POST", headers: { "Content-Type": "application/json", authorization }, body: JSON.stringify(page) });
        await response.text();
        await settle();
        return response.status;
    };
    const callback = async (authorization: string) => {
        const response = await fetch(`${at}/api/v3/hiu/consent/request/on-init`, {
            method: "POST",
            headers: { "Content-Type": "application/json", authorization, "REQUEST-ID": "11111111-2222-3333-4444-555555555555", "X-HIU-ID": HIU },
            body: JSON.stringify({ response: { requestId: "r-1" } }),
        });
        await response.text();
        return response.status;
    };
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        pushAnswer = { accepted: true, status: 202 };
        addressAnswer = null;
        const hip = sign({ clientId: "SBX_HIP", exp: seconds(5) });
        for (const authorization of [`Bearer ${hip}`, `bearer ${hip}`, `BEARER   ${hip}`, hip]) {
            assert.equal(await push(authorization), 202, authorization.slice(0, 9));
        }
        // A HIP's cached token, signed by ABDM, inside the grace; then one well past it.
        assert.equal(await push(`Bearer ${sign({ clientId: "SBX_HIP", exp: seconds(-30) })}`), 202);
        refusals.length = 0;
        assert.equal(await push(`Bearer ${sign({ clientId: "SBX_HIP", exp: seconds(-90) })}`), 401);
        assert.equal(await push(`Bearer ${sign({ clientId: "SBX_HIP", exp: seconds(5) }, { alg: "HS256", kid: "gw-key-1" })}`), 401);
        assert.equal(await push(`Basic ${hip}`), 401);
        assert.deepEqual(refusals, [
            { token: TOKEN, status: 401, reason: "token too old (ran out 90 minutes ago; up to 60 are allowed)" },
            { token: TOKEN, status: 401, reason: "token not signed by ABDM (not an RS256 token with a key id)" },
            { token: TOKEN, status: 401, reason: "no bearer token" },
        ]);
        assert.ok(refusals.every((refusal) => !/expired/i.test(refusal.reason)));

        // The gateway's callbacks: the exact "Bearer " and the strict expiry, as before.
        const gateway = sign({ clientId: "gateway", exp: seconds(5) });
        assert.equal(await callback(`Bearer ${gateway}`), 200);
        assert.equal(await callback(`bearer ${gateway}`), 401);
        assert.equal(await callback(gateway), 401);
        assert.equal(await callback(`Bearer ${sign({ clientId: "gateway", exp: seconds(-30) })}`), 401, "no grace for a gateway callback");
    } finally {
        console.warn = originalWarn;
        s.close();
    }
});

test("data push: an unknown, ended or closed push address is refused before the body is read, even an oversize one", async () => {
    for (const refusal of [
        { accepted: false, status: 404, reason: "Not found." },
        { accepted: false, status: 409, reason: "This transfer has already ended." },
        { accepted: false, status: 410, reason: "The window for this transfer has closed." },
    ]) {
        calls.length = 0;
        addressChecks.length = 0;
        addressAnswer = refusal;
        // Over the ~10 KB limit: refused by the address check, not parsed into a 413.
        const answer = await post(`/api/v3/hiu/data-push/${TOKEN}`, { authorization: "Bearer hip-token" }, { transactionId: "t", entries: [{ content: "x".repeat(20_000) }] });
        assert.equal(answer.status, refusal.status);
        assert.deepEqual(answer.json, { error: { code: String(refusal.status), message: refusal.reason } });
        assert.deepEqual(addressChecks, [TOKEN]);
        assert.equal(calls.length, 0, "acceptPush never ran");
    }
    addressAnswer = null;

    // The bearer still comes first: no address lookup for a forged token.
    addressChecks.length = 0;
    assert.equal((await post(`/api/v3/hiu/data-push/${TOKEN}`, { authorization: "Bearer forged" }, { transactionId: "t" })).status, 401);
    assert.deepEqual(addressChecks, []);
});

test("a refused push token reads as plain words for the record, never the login-lapse word", () => {
    assert.equal(pushAuthRefusalReason(new Error("socket hang up"), 60), "ABDM's signing keys could not be read to check the token");
    assert.equal(pushAuthRefusalReason(new CallbackAuthError("x", "ran-out", { ranOutMinutesAgo: 75 }), 60), "token too old (ran out 75 minutes ago; up to 60 are allowed)");
    assert.equal(pushAuthRefusalReason(new CallbackAuthError("x", "ran-out"), 60), "token too old");
    assert.equal(pushAuthRefusalReason(new CallbackAuthError("x", "unknown-key"), 60), "token not signed by ABDM (signed with a key ABDM does not publish)");
    for (const reason of ["no-token", "unreadable", "not-rs256", "unknown-key", "bad-signature", "ran-out", "not-yet-valid", "client-not-allowed"] as const) {
        const text = pushAuthRefusalReason(new CallbackAuthError("x", reason), 60);
        assert.ok(text.length > 0 && !/expired/i.test(text), reason);
    }
});

test("the push route's own parser takes bodies above the global 100 KB limit", async () => {
    const roomy = express();
    roomy.use("/api/v3/hiu/data-push", createHiuDataPushRouter(controller, 1));
    roomy.use(express.json());
    const s = roomy.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => s.once("listening", () => resolve()));
    try {
        pushAnswer = { accepted: true, status: 202 };
        const response = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/v3/hiu/data-push/${TOKEN}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", authorization: "Bearer hip-token" },
            body: JSON.stringify({ transactionId: "t", entries: [{ content: "x".repeat(300_000) }] }),
        });
        assert.equal(response.status, 202);
    } finally {
        s.close();
    }
});

test("the log summary shows structure, ids and statuses, never patient data or content", () => {
    const summary = callbackSummary({
        notification: { consentRequestId: "c-1", status: "GRANTED", consentArtefacts: [{ id: "a-1" }, { id: "a-2" }] },
        consent: { consentDetail: { consentId: "a-1", patient: { id: "someone@sbx" }, careContexts: [{ careContextReference: "CC-SECRET" }] } },
        entries: [{ content: "CIPHER" }],
        keyMaterial: { nonce: "NONCE", dhPublicKey: { keyValue: "KEY" } },
        response: { requestId: "r-1" },
    });
    assert.match(summary, /consentArtefacts\[2\]/);
    assert.match(summary, /notification\.consentRequestId=c-1/);
    assert.match(summary, /notification\.status=GRANTED/);
    assert.match(summary, /consent\.consentDetail\.consentId=a-1/);
    assert.match(summary, /response\.requestId=r-1/);
    for (const secret of ["someone", "sbx", "CC-SECRET", "CIPHER", "NONCE", "KEY\b"]) {
        assert.doesNotMatch(summary, new RegExp(secret), secret);
    }
});
