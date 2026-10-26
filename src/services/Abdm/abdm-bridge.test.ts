import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AbdmGatewayService } from "./abdm-gateway.service.js";
import { AbdmBridgeService, BridgeUrlError, checkBridgeUrl, type HipHospitalLookup } from "./abdm-bridge.service.js";

const DEPLOYMENT = "https://clinicx-api.example.test";
const HFR_ID = "IN3610000001";

const realFetch = globalThis.fetch;
const realConsole = { log: console.log, warn: console.warn, error: console.error };
let requested: string[];

/** The registry as the sandbox answered it on 2026-10-26, with test ids. */
const registry = (overrides: { url?: string; services?: unknown[]; active?: boolean } = {}) => ({
    bridge: { id: "SBX_TEST", name: "TEST BRIDGE", url: overrides.url ?? DEPLOYMENT, active: overrides.active ?? true, blocklisted: false, entity: "NA" },
    services: overrides.services ?? [
        { id: "Test-HIP", name: "Test", types: ["HIP", "HIU"], endpoints: {}, active: true },
        { id: HFR_ID, name: "Test Hospital", types: ["HIP", "HIU"], active: true },
    ],
});

const serviceDetails = { id: 1, bridgeId: "SBX_TEST", serviceId: HFR_ID, name: "Test Hospital", isHip: true, isHiu: true, active: true };
/** What the sandbox answered for a service id with a hyphen, 2026-10-26. */
const hyphenRefusal = [{ error: { code: "ABDM-1002: ", message: "Invalid HIP ID, it must be in Alpha numeric and _ in middle" } }];

const stub = (answers: { registry?: unknown; service?: { status: number; body: unknown } }) => {
    globalThis.fetch = (async (url: any) => {
        const path = new URL(String(url)).pathname;
        requested.push(path);
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (path.endsWith("/gateway/v3/sessions")) return json(200, { accessToken: "t", expiresIn: 1200, tokenType: "bearer" });
        if (path.endsWith("/gateway/v3/bridge-services")) return json(200, answers.registry ?? registry());
        if (path.includes("/gateway/v3/bridge-service/serviceId/")) {
            const service = answers.service ?? { status: 200, body: serviceDetails };
            return json(service.status, service.body);
        }
        return json(404, {});
    }) as typeof fetch;
};

const hospitals = (names: Record<number, string> = { 12: "Test Hospital" }): HipHospitalLookup => ({
    findHospitalName: async (id) => names[id] ?? null,
});

const check = (lookup = hospitals()) => new AbdmBridgeService(lookup, new AbdmGatewayService()).checkReadiness();

beforeEach(() => {
    requested = [];
    process.env.ABDM_CLIENT_ID = "SBX_TEST";
    process.env.ABDM_CLIENT_SECRET = "secret";
    process.env.ABDM_BRIDGE_URL = `${DEPLOYMENT}/`;
    process.env.ABDM_M2_HIP_ID = HFR_ID;
    process.env.ABDM_M2_HIP_HOSPITAL_ID = "12";
    for (const level of ["log", "warn", "error"] as const) console[level] = () => {};
});

afterEach(() => {
    globalThis.fetch = realFetch;
    Object.assign(console, realConsole);
    for (const name of ["ABDM_BRIDGE_URL", "ABDM_M2_HIP_ID", "ABDM_M2_HIP_HOSPITAL_ID"]) delete process.env[name];
});

test("ready when the bridge calls back here and ABDM accepts the HIP id", async () => {
    process.env.ABDM_HIP_ID = "Test-HIP"; // Scan and Share's id, which M2 must not use
    stub({});
    const result = await check();
    delete process.env.ABDM_HIP_ID;

    assert.equal(result.hip?.hipId, HFR_ID);
    assert.ok(!requested.some((p) => p.includes("Test-HIP")), "M2 never looks up Scan and Share's id");

    assert.equal(result.ready, true, result.problems.join("; "));
    assert.deepEqual(result.problems, []);
    assert.equal(result.hip?.hospitalName, "Test Hospital");
    assert.equal(result.hip?.isHip, true);
    assert.equal(result.services.length, 2, "the whole service list is kept");
    assert.ok(requested.some((p) => p.endsWith(`/serviceId/${HFR_ID}`)), "ABDM is asked about the HIP id itself");
});

test("a bridge calling back somewhere else is not ready, and names both URLs", async () => {
    stub({ registry: registry({ url: "https://someone.ngrok-free.dev" }) });
    const result = await check();

    assert.equal(result.ready, false);
    assert.match(result.problems[0]!, /someone\.ngrok-free\.dev/);
    assert.match(result.problems[0]!, /clinicx-api\.example\.test/);
});

test("without ABDM_BRIDGE_URL the callback target can't be confirmed", async () => {
    delete process.env.ABDM_BRIDGE_URL;
    stub({});
    const result = await check();

    assert.equal(result.ready, false);
    assert.match(result.problems[0]!, /ABDM_BRIDGE_URL is not set/);
});

test("ABDM's refusal of the HIP id is passed on with its code and request id", async () => {
    process.env.ABDM_M2_HIP_ID = "Test-HIP";
    stub({ service: { status: 400, body: hyphenRefusal } });
    const result = await check();

    assert.equal(result.ready, false);
    assert.equal(result.hip?.onBridge, true, "listed on the bridge, yet refused");
    assert.equal(result.hip?.refusal?.code, "ABDM-1002");
    assert.ok(result.hip?.refusal?.requestId);
    assert.ok(result.problems.some((p) => p.includes("Invalid HIP ID")));
});

test("an HIP id that is not on the bridge is a problem", async () => {
    process.env.ABDM_M2_HIP_ID = "IN3610009999";
    stub({ service: { status: 200, body: { ...serviceDetails, serviceId: "IN3610009999" } } });
    const result = await check();

    assert.equal(result.ready, false);
    assert.ok(result.problems.some((p) => p.includes("not a service on this bridge")));
});

test("a hospital id that the clinic database does not have is a problem", async () => {
    process.env.ABDM_M2_HIP_HOSPITAL_ID = "999";
    stub({});
    const result = await check();

    assert.equal(result.ready, false);
    assert.ok(result.problems.some((p) => p.includes("no such hospital")));
});

test("a bridge URL is an https origin with no path", () => {
    assert.equal(checkBridgeUrl("https://clinicx-api.example.test/"), "https://clinicx-api.example.test");
    assert.throws(() => checkBridgeUrl("http://clinicx-api.example.test"), BridgeUrlError);
    assert.throws(() => checkBridgeUrl("https://clinicx-api.example.test/api"), /no path/);
    assert.throws(() => checkBridgeUrl("not a url"), BridgeUrlError);
    assert.throws(() => checkBridgeUrl(undefined), BridgeUrlError);
});

test("updating the bridge URL sends the origin, then reads the registry back", async () => {
    const patched: unknown[] = [];
    let current = "https://someone.ngrok-free.dev";
    globalThis.fetch = (async (url: any, init: any) => {
        const path = new URL(String(url)).pathname;
        requested.push(`${init.method} ${path}`);
        const json = (status: number, body: unknown) => new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (path.endsWith("/gateway/v3/sessions")) return json(200, { accessToken: "t", expiresIn: 1200 });
        if (path.endsWith("/gateway/v3/bridge/url")) {
            patched.push(JSON.parse(init.body));
            current = JSON.parse(init.body).url;
            return json(202, undefined);
        }
        if (path.endsWith("/gateway/v3/bridge-services")) return json(200, registry({ url: current }));
        return json(200, serviceDetails);
    }) as typeof fetch;

    const result = await new AbdmBridgeService(hospitals(), new AbdmGatewayService()).updateBridgeUrl(`${DEPLOYMENT}/`);

    assert.deepEqual(patched, [{ url: DEPLOYMENT }]);
    assert.ok(requested.indexOf("PATCH /api/hiecm/gateway/v3/bridge/url") < requested.indexOf("GET /api/hiecm/gateway/v3/bridge-services"), "read back after the update");
    assert.equal(result.bridge.url, DEPLOYMENT);
    assert.equal(result.ready, true, result.problems.join("; "));
});

test("an update ABDM accepts but does not apply is reported", async () => {
    stub({ registry: registry({ url: "https://someone.ngrok-free.dev" }) });
    const realStub = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) =>
        String(url).endsWith("/bridge/url") ? new Response("", { status: 202 }) : realStub(url, init)) as typeof fetch;

    const result = await new AbdmBridgeService(hospitals(), new AbdmGatewayService()).updateBridgeUrl(DEPLOYMENT);

    assert.equal(result.ready, false);
    assert.match(result.problems[0]!, /still reports https:\/\/someone\.ngrok-free\.dev/);
});

test("an invalid bridge URL is never sent", async () => {
    stub({});
    await assert.rejects(new AbdmBridgeService(hospitals(), new AbdmGatewayService()).updateBridgeUrl("https://x.example.test/api"), BridgeUrlError);
    assert.ok(!requested.some((p) => p.includes("bridge/url")));
});

test("an inactive bridge is a problem", async () => {
    stub({ registry: registry({ active: false }) });
    const result = await check();

    assert.equal(result.ready, false);
    assert.ok(result.problems.some((p) => p.includes("inactive")));
});
