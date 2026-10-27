import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { CallbackAuthError } from "../../services/Abdm/abdm-callback-auth.service.js";
import { callbackSummary, createHiuCallbackController, type HiuCallbackServices } from "./hiu-callback.controller.js";
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
const authCalls: { pinClient: boolean | undefined }[] = [];
const auth = {
    async verify(authorization: string | undefined, options: { pinClient?: boolean } = {}) {
        authCalls.push({ pinClient: options.pinClient });
        if (authorization === "Bearer gateway-token") return { clientId: "gateway" };
        if (authorization === "Bearer hip-token") {
            if (options.pinClient === false) return { clientId: "SBX_HIP" };
            throw new CallbackAuthError(`The callback came from ABDM client "SBX_HIP", which is not allowed.`);
        }
        if (authorization === "Bearer forged") throw new CallbackAuthError("The callback token's signature does not match ABDM's key.");
        throw new CallbackAuthError("The callback carries no bearer token.");
    },
};

const calls: { method: string; body: any; headers?: any; token?: string }[] = [];
let pushAnswer = { accepted: true, status: 202 } as { accepted: boolean; status: number; reason?: string };
/** What the push address check answers (null: an open transfer), and the tokens it was asked about. */
let addressAnswer: { accepted: boolean; status: number; reason?: string } | null = null;
const addressChecks: string[] = [];
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
    },
};

const controller = createHiuCallbackController({ auth, services: async () => services, directory });

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
    assert.deepEqual(authCalls, [{ pinClient: undefined }], "the default (pinned) verify");
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
    assert.deepEqual(authCalls, [{ pinClient: false }]);
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

test("data push: no bearer or a forged one is refused before the body is read or acceptPush runs", async () => {
    calls.length = 0;
    assert.equal((await post(`/api/v3/hiu/data-push/${TOKEN}`, {}, { transactionId: "t" })).status, 401);
    assert.equal((await post(`/api/v3/hiu/data-push/${TOKEN}`, { authorization: "Bearer forged" }, { transactionId: "t" })).status, 401);
    assert.equal(calls.length, 0);
});

test("data push: a body over ABDM_DATA_PUSH_MAX_MB gets a JSON 413, and broken JSON a JSON 400", async () => {
    calls.length = 0;
    const big = await post(`/api/v3/hiu/data-push/${TOKEN}`, { authorization: "Bearer hip-token" }, { entries: [{ content: "x".repeat(20_000) }] });
    assert.equal(big.status, 413);
    assert.equal(big.json.error.code, "413");
    const broken = await post(`/api/v3/hiu/data-push/${TOKEN}`, { authorization: "Bearer hip-token" }, "{not json");
    assert.equal(broken.status, 400);
    assert.equal(broken.json.error.code, "400");
    assert.equal(calls.length, 0);
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
