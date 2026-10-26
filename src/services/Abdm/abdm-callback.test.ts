import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "crypto";
import { AbdmCallbackService, type CallbackStore, type StoredCallback } from "./abdm-callback.service.js";
import { AbdmCallbackAuth } from "./abdm-callback-auth.service.js";

const HIP = "IN3610000001";
const SENT = "6f0b4665-a915-4c92-aa36-65afb4a2cd71";
const LINK_TOKEN = "link-token-never-stored";
const NOW = Date.parse("2026-10-26T10:00:01.000Z");

/** ABDM's gateway, as AbdmCallbackAuth sees it: one published RS256 key, and tokens it signs. */
const gatewayKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const published = { keys: [{ ...gatewayKey.publicKey.export({ format: "jwk" }), kid: "gateway-key-1", alg: "RS256", use: "sig" }] };
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const signToken = (claims: object, privateKey = gatewayKey.privateKey) => {
    const head = `${b64({ alg: "RS256", typ: "JWT", kid: "gateway-key-1" })}.${b64(claims)}`;
    const signer = createSign("RSA-SHA256");
    signer.update(head);
    return `${head}.${signer.sign(privateKey).toString("base64url")}`;
};
const BEARER = signToken({ clientId: "gateway", exp: Math.floor(NOW / 1000) + 300 });
let keysAvailable: boolean;

/** Behaves like AbdmExchangeRepository: one outbound exchange waiting on SENT. */
class MemoryStore implements CallbackStore {
    outbound = new Map<string, { state: string; callback?: StoredCallback }>([[SENT, { state: "accepted" }]]);
    inbound = new Map<string, StoredCallback>();

    async answer(answeredRequestId: string, callback: StoredCallback) {
        const exchange = this.outbound.get(answeredRequestId);
        if (!exchange) return "unknown" as const;
        if (exchange.state === "answered") return "duplicate" as const;
        if (exchange.state !== "sent" && exchange.state !== "accepted") return "unknown" as const;
        exchange.state = "answered";
        exchange.callback = callback;
        return "answered" as const;
    }

    async receive(callback: StoredCallback) {
        if (this.inbound.has(callback.requestId)) return "duplicate" as const;
        this.inbound.set(callback.requestId, callback);
        return "stored" as const;
    }
}

const realConsole = { log: console.log, warn: console.warn };
let store: MemoryStore;
let service: AbdmCallbackService;

const headers = (overrides: Record<string, string | undefined> = {}) => {
    const all: Record<string, string | undefined> = {
        authorization: `Bearer ${BEARER}`,
        "request-id": "d20b575b-2659-4a1b-8c2d-9e3f5a6b7c8d",
        timestamp: "2026-10-26T10:00:00.000Z",
        "x-hip-id": HIP,
        "content-type": "application/json",
        ...overrides,
    };
    return Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined)) as Record<string, string>;
};

const tokenAnswer = { abhaAddress: "someone@sbx", linkToken: LINK_TOKEN, response: { requestId: SENT } };
const discovery = {
    transactionId: "f901b782-bfdf-4224-9f8d-da2cadc20c0d",
    patient: { id: "someone@sbx", name: "Test Patient", gender: "M", yearOfBirth: 1990, verifiedIdentifiers: [{ type: "MOBILE", value: "+919800000000" }] },
};

let facilities: string[];

beforeEach(() => {
    facilities = [HIP];
    store = new MemoryStore();
    keysAvailable = true;
    const auth = new AbdmCallbackAuth({
        async call<T>(): Promise<T> {
            if (!keysAvailable) throw new Error("gateway unreachable");
            return published as T;
        },
    }, () => NOW, { callbackClientIds: async () => ["gateway"] });
    service = new AbdmCallbackService(store, auth, () => new Date(NOW), {}, {
        hipById: async (id) => (id && facilities.includes(id) ? { id, hospitalId: 12, name: "Ocimum Dental Clinic" } : null),
    });
    console.log = () => {};
    console.warn = () => {};
});

afterEach(() => {
    Object.assign(console, realConsole);
});

test("a valid answer without Authorization is refused before anything is stored", async () => {
    const outcome = await service.receive({ path: "/api/v3/hip/token/on-generate-token", headers: headers({ authorization: undefined }), body: tokenAnswer });

    assert.equal(outcome.status, 401);
    assert.equal(store.outbound.get(SENT)!.state, "accepted", "the exchange is still waiting");
});

test("a Basic or empty Authorization is refused too", async () => {
    for (const authorization of ["Basic abc", "Bearer ", ""]) {
        const outcome = await service.receive({ path: "/api/v3/hip/patient/care-context/discover", headers: headers({ authorization }), body: discovery });
        assert.equal(outcome.status, 401, `"${authorization}"`);
    }
    assert.equal(store.inbound.size, 0);
});

test("a token ABDM did not sign, or signed for another client, is refused before anything is stored", async () => {
    const forged = signToken({ clientId: "gateway", exp: Math.floor(NOW / 1000) + 300 }, otherKey.privateKey);
    const otherClient = signToken({ clientId: "SBX_SOMEONE_ELSE", exp: Math.floor(NOW / 1000) + 300 });
    const expired = signToken({ clientId: "gateway", exp: Math.floor(NOW / 1000) - 3600 });
    for (const token of [forged, otherClient, expired]) {
        const outcome = await service.receive({ path: "/api/v3/hip/token/on-generate-token", headers: headers({ authorization: `Bearer ${token}` }), body: tokenAnswer });
        assert.equal(outcome.status, 401);
    }
    assert.equal(store.outbound.get(SENT)!.state, "accepted", "the exchange is still waiting");
});

test("when ABDM's keys can't be fetched, nothing is stored and the failure is thrown (a 5xx, so ABDM retries)", async () => {
    keysAvailable = false;
    await assert.rejects(service.receive({ path: "/api/v3/hip/patient/care-context/discover", headers: headers(), body: discovery }));
    assert.equal(store.inbound.size, 0);
});

test("a callback for another facility is refused and not stored", async () => {
    const outcome = await service.receive({ path: "/api/v3/hip/patient/care-context/discover", headers: headers({ "x-hip-id": "IN9999999999" }), body: discovery });

    assert.equal(outcome.status, 403);
    assert.equal(store.inbound.size, 0);
});

test("with no facility set up, nothing is accepted", async () => {
    facilities = [];
    const outcome = await service.receive({ path: "/api/v3/hip/patient/care-context/discover", headers: headers({ "x-hip-id": "" }), body: discovery });

    assert.equal(outcome.status, 403);
    assert.equal(store.inbound.size, 0);
});

test("an answer to a request this system never sent is refused and not stored", async () => {
    const outcome = await service.receive({
        path: "/api/v3/hip/token/on-generate-token",
        headers: headers(),
        body: { ...tokenAnswer, response: { requestId: "00000000-0000-0000-0000-000000000000" } },
    });

    assert.equal(outcome.status, 400);
    assert.equal(store.outbound.get(SENT)!.state, "accepted");
});

test("an answer without response.requestId is refused", async () => {
    const outcome = await service.receive({ path: "/api/v3/link/on_carecontext", headers: headers(), body: { abhaAddress: "someone@sbx" } });
    assert.equal(outcome.status, 400);
});

test("an answer closes its exchange once, with the link token and bearer never stored", async () => {
    const first = await service.receive({ path: "/api/v3/hip/token/on-generate-token", headers: headers(), body: tokenAnswer });
    assert.equal(first.status, 202);

    const exchange = store.outbound.get(SENT)!;
    assert.equal(exchange.state, "answered");
    const stored = exchange.callback!;
    assert.equal(stored.path, "/api/v3/hip/token/on-generate-token");
    assert.equal(stored.hipId, HIP);
    assert.ok(!stored.body.includes(LINK_TOKEN), "link token masked");
    assert.ok(stored.body.includes("linkToken"), "the body's shape is kept");
    assert.ok(stored.body.includes("someone@sbx"));
    assert.ok(!stored.headers.includes(BEARER), "headers are stored as lengths");
    assert.equal(JSON.parse(stored.headers).authorization, `Bearer ${BEARER}`.length);

    const again = await service.receive({ path: "/api/v3/hip/token/on-generate-token", headers: headers(), body: tokenAnswer });
    assert.equal(again.status, 409, "a second answer is not acted on");
});

test("an ABDM request is stored whole and acknowledged; a redelivery is acknowledged, not stored twice", async () => {
    const first = await service.receive({ path: "/api/v3/hip/patient/care-context/discover", headers: headers(), body: discovery });
    assert.equal(first.status, 202);
    assert.equal(store.inbound.size, 1);
    const stored = [...store.inbound.values()][0]!;
    assert.deepEqual(JSON.parse(stored.body), discovery, "stored whole before anything reads it");

    const again = await service.receive({ path: "/api/v3/hip/patient/care-context/discover", headers: headers(), body: discovery });
    assert.equal(again.status, 202);
    assert.equal(store.inbound.size, 1);
});

test("a path this HIP does not serve is not stored", async () => {
    const outcome = await service.receive({ path: "/api/v3/hip/patient/share", headers: headers(), body: { any: "thing" } });
    assert.equal(outcome.status, 404);
    assert.equal(store.inbound.size, 0);
});

test("a missing REQUEST-ID or body is refused", async () => {
    assert.equal((await service.receive({ path: "/api/v3/consent/request/hip/notify", headers: headers({ "request-id": undefined }), body: { notification: {} } })).status, 400);
    assert.equal((await service.receive({ path: "/api/v3/consent/request/hip/notify", headers: headers(), body: undefined })).status, 400);
    assert.equal(store.inbound.size, 0);
});
