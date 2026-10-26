import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import { AbdmApiError, type AbdmCall } from "../abdm-gateway.service.js";
import { checksumOf, decryptEntry, encryptEntry, generateKeyMaterial, verifyChecksum, KEY_MATERIAL_CURVE, KEY_MATERIAL_CRYPTO_ALG, KEY_MATERIAL_PARAMETERS } from "./fidelius-crypto.js";
import { atRestKeysFrom, open, seal, type AtRestKeys } from "./hiu-at-rest.js";
import type { HiuAuditEventInput } from "./hiu-audit.js";
import { DATA_PUSH_URL_PATTERN, HiuError } from "./hiu-enums.js";
import {
    HIU_RECORDS_RESPONSE_MAX_BYTES,
    HiuDataFlowService,
    sha256Hex,
    type HiuDataArtefact,
    type HiuDataFlowSettings,
    type HiuDataRequestRow,
    type HiuDataStore,
    type HiuRecordRow,
} from "./hiu-data-flow.service.js";
import { HiuMaintenanceService } from "./hiu-maintenance.service.js";

const KEYS: AtRestKeys = atRestKeysFrom({ key: randomBytes(32).toString("base64"), keyId: "t1" })!;
const HOSPITAL = 7;
const STAFF = { staffUserId: "11111111-1111-1111-1111-111111111111", hospitalId: HOSPITAL, organizationId: 3 };
const T0 = Date.parse("2026-10-26T10:00:00.000Z");
const GRANT_FROM = new Date("2024-01-15T05:30:00.123Z");
const GRANT_TO = new Date("2026-10-20T18:29:59.999Z");
const ERASE_AT = new Date("2026-12-31T00:00:00.000Z");
const TRANSACTION = "5a7c9e1f-0000-4000-8000-00000000abcd";

// ---- In-memory store, with the database's guarantees: the unique page index and atomic claims ----

let now: number;
let artefacts: Map<number, HiuDataArtefact>;
let requests: HiuDataRequestRow[];
let records: (HiuRecordRow & { artefactFk: number; hospitalId: number })[];
let calls: AbdmCall[];
let audits: HiuAuditEventInput[];
let tasks: Promise<void>[];
let decrypts: number;
let settings: HiuDataFlowSettings;
let gatewayFault: ((call: AbdmCall) => void | Promise<void>) | null;
/** Checked inside the gateway stub: the data request must be stored before the call goes out. */
let storedBeforeCall: boolean[];
/** BytesReceived per data request. */
let bytesReceived: Map<number, number>;
/** The content budget the last listRecords was given. */
let listBudgets: number[];

/** Like the repository's SHOWN_TRANSFER: the latest RECEIVED transfer holding entries, else the latest holding entries. */
const shownTransfer = (artefactFk: number): number | undefined => {
    const holding = requests.filter((row) => row.artefactFk === artefactFk && records.some((r) => r.dataRequestFk === row.id && r.entryIndex >= 0)).reverse();
    return (holding.find((row) => row.sessionStatus === "RECEIVED") ?? holding[0])?.id;
};

const store: HiuDataStore = {
    async findArtefact(id) { return artefacts.has(id) ? { ...artefacts.get(id)! } : null; },
    async findOpenDataRequest(artefactFk) {
        return [...requests].reverse().find((row) => row.artefactFk === artefactFk && ["REQUESTED", "RECEIVING"].includes(row.sessionStatus)) ?? null;
    },
    async hasReceivedRecords(artefactFk) {
        return requests.some((row) => row.artefactFk === artefactFk && row.sessionStatus === "RECEIVED"
            && records.some((r) => r.dataRequestFk === row.id && r.entryIndex >= 0));
    },
    async createDataRequest(row) {
        const id = requests.length + 1;
        requests.push({ ...row, id, transactionId: null, pageCount: null, pagesReceived: 0, careContextStatus: null, notifiedAt: null, notifyRequestId: null, error: null, createdAt: new Date(now), completedAt: null });
        return id;
    },
    async updateDataRequest(id, changes) { Object.assign(requests.find((row) => row.id === id)!, changes); },
    async failUnansweredRequest(id, { at, error }) {
        const row = requests.find((r) => r.id === id)!;
        if (row.transactionId !== null || row.sessionStatus !== "REQUESTED" || row.notifiedAt) return false;
        Object.assign(row, { sessionStatus: "FAILED", privateKey: null, completedAt: at, error });
        return true;
    },
    async reserveBytes(id, bytes, maxBytes) {
        const total = (bytesReceived.get(id) ?? 0) + bytes;
        if (total > maxBytes) return false;
        bytesReceived.set(id, total);
        return true;
    },
    async findDataRequest(id) { const row = requests.find((r) => r.id === id); return row ? { ...row } : null; },
    async findDataRequestByHiRequestId(hiRequestId) { const row = requests.find((r) => r.hiRequestId === hiRequestId); return row ? { ...row } : null; },
    async findDataRequestByTokenHash(hash) { const row = requests.find((r) => r.pushTokenHash === hash); return row ? { ...row } : null; },
    async adoptTransactionId(id, transactionId) {
        const row = requests.find((r) => r.id === id)!;
        if (row.transactionId !== null || requests.some((r) => r.transactionId === transactionId)) return false;
        row.transactionId = transactionId;
        return true;
    },
    async claimPageCount(id, pageCount) {
        const row = requests.find((r) => r.id === id)!;
        if (!(row.pageCount === null || row.pageCount === pageCount) || !["REQUESTED", "RECEIVING"].includes(row.sessionStatus) || row.notifiedAt) return false;
        row.pageCount = pageCount;
        if (row.sessionStatus === "REQUESTED") row.sessionStatus = "RECEIVING";
        return true;
    },
    async hasPage(dataRequestId, pageNumber) { return records.some((r) => r.dataRequestFk === dataRequestId && r.pageNumber === pageNumber); },
    async addPage({ dataRequestId, artefactFk, hospitalId, pageNumber, records: page }) {
        // A database round trip: other pages can interleave here.
        await new Promise((resolve) => setImmediate(resolve));
        // Checked inside the transaction, like the repository: the artefact still granted, the transfer still open.
        const artefact = artefacts.get(artefactFk);
        const row = requests.find((r) => r.id === dataRequestId)!;
        if (!artefact || artefact.status !== "GRANTED" || artefact.recordsPurgedAt
            || row.notifiedAt || !["REQUESTED", "RECEIVING"].includes(row.sessionStatus) || !row.privateKey) {
            return { duplicate: false, closed: true, pagesReceived: 0 };
        }
        if (page.some((entry) => records.some((r) => r.dataRequestFk === dataRequestId && r.pageNumber === pageNumber && r.entryIndex === entry.entryIndex))) {
            return { duplicate: true, pagesReceived: 0 };
        }
        for (const entry of page) {
            records.push({ ...entry, id: records.length + 1, dataRequestFk: dataRequestId, artefactFk, hospitalId, pageNumber, receivedAt: new Date(now) });
        }
        row.pagesReceived += 1;
        return { duplicate: false, pagesReceived: row.pagesReceived };
    },
    async claimNotify(id, at, notifyRequestId) {
        const row = requests.find((r) => r.id === id)!;
        if (row.notifiedAt) return false;
        row.notifiedAt = at;
        row.notifyRequestId = notifyRequestId;
        return true;
    },
    async listEntryOutcomes(dataRequestId) {
        return records.filter((r) => r.dataRequestFk === dataRequestId && r.entryIndex >= 0).map((r) => ({ careContextReference: r.careContextReference, ok: r.checksumOk && r.content !== null }));
    },
    async listRecords(artefactFk, at, maxContentBytes) {
        listBudgets.push(maxContentBytes);
        let running = 0;
        const shown = shownTransfer(artefactFk);
        return records.filter((r) => r.artefactFk === artefactFk && r.dataRequestFk === shown && r.entryIndex >= 0 && (!r.deleteAt || r.deleteAt > at)).map((r) => {
            running += r.content ? r.content.length * 2 : 0;
            return running <= maxContentBytes ? { ...r, contentOmitted: false } : { ...r, content: null, contentOmitted: r.content !== null };
        });
    },
    async findRecord(artefactFk, recordId, at) {
        const row = records.find((r) => r.id === recordId && r.artefactFk === artefactFk && r.dataRequestFk === shownTransfer(artefactFk) && r.entryIndex >= 0 && (!r.deleteAt || r.deleteAt > at));
        return row ? { ...row } : null;
    },
};

const gateway = {
    async call<T = any>(call: AbdmCall): Promise<T> {
        if (call.path.endsWith("/health-information/request")) {
            storedBeforeCall.push(requests.some((row) => row.hiRequestId === call.requestId));
        }
        calls.push(call);
        await gatewayFault?.(call);
        return {} as T;
    },
};

const audit = { async record(event: HiuAuditEventInput) { audits.push(event); } };

const crypto = {
    generateKeyMaterial,
    decryptEntry: (input: Parameters<typeof decryptEntry>[0]) => {
        decrypts += 1;
        return decryptEntry(input);
    },
    verifyChecksum,
};

const makeService = () => new HiuDataFlowService({
    store,
    audit,
    gateway,
    clock: () => now,
    crypto,
    atRestKeys: () => KEYS,
    settings: () => settings,
    runInBackground: (task) => { tasks.push(task()); },
});

/** Waits for every background page, including work those pages start. */
const settle = async () => {
    while (tasks.length) {
        const pending = tasks.splice(0);
        await Promise.all(pending);
    }
};

const grantedArtefact = (overrides: Partial<HiuDataArtefact> = {}): HiuDataArtefact => ({
    id: 1,
    consentArtefactId: "art-0001",
    consentRequestId: "cr-0001",
    hospitalId: HOSPITAL,
    hipId: "IN2810014366",
    status: "GRANTED",
    dateFrom: GRANT_FROM,
    dateTo: GRANT_TO,
    dataEraseAt: ERASE_AT,
    fetchedAt: new Date(T0 - 60_000),
    careContexts: seal(JSON.stringify([{ patientReference: "P1", careContextReference: "CC-A" }, { patientReference: "P1", careContextReference: "CC-B" }]), KEYS),
    recordsPurgedAt: null,
    ...overrides,
});

const bundle = (id: string) => ({ resourceType: "Bundle", id, type: "document", entry: [{ resource: { resourceType: "Composition", title: `Note ${id}` } }] });

/** What the HIP learns from ABDM: our public key, our nonce and the push address. */
const hiRequestOf = () => calls.find((call) => call.path.endsWith("/health-information/request"))!.body as any;
const pushTokenOf = () => hiRequestOf().hiRequest.dataPushUrl.split("/").pop() as string;

/** Encrypts entries as a HIP would, with fresh key material for the page. */
const hipPage = (pageNumber: number, pageCount: number, entries: { reference: string; content?: string; checksum?: string }[], transactionId = TRANSACTION) => {
    const ours = hiRequestOf().hiRequest.keyMaterial;
    const hip = generateKeyMaterial();
    return {
        pageNumber,
        pageCount,
        transactionId,
        entries: entries.map((entry) => entry.content === undefined
            ? { media: "application/fhir+json", checksum: "", careContextReference: entry.reference }
            : {
                content: encryptEntry({ privateKey: hip.privateKey, ourNonce: hip.nonce, peerPublicKeyValue: ours.dhPublicKey.keyValue, peerNonce: ours.nonce, plaintext: entry.content }),
                media: "application/fhir+json",
                checksum: entry.checksum ?? checksumOf(entry.content),
                careContextReference: entry.reference,
            }),
        keyMaterial: {
            cryptoAlg: KEY_MATERIAL_CRYPTO_ALG,
            curve: KEY_MATERIAL_CURVE,
            dhPublicKey: { expiry: new Date(now + 600_000).toISOString(), parameters: KEY_MATERIAL_PARAMETERS, keyValue: hip.publicKeyValue },
            nonce: hip.nonce,
        },
    };
};

const notifies = () => calls.filter((call) => call.path.endsWith("/health-information/notify"));

/** Requests records for artefact 1 and acknowledges with TRANSACTION. */
const openTransfer = async (service: HiuDataFlowService) => {
    await service.requestForArtefact(1);
    await service.onRequest({ hiRequest: { transactionId: TRANSACTION, sessionStatus: "REQUESTED" }, error: null, response: { requestId: requests[0].hiRequestId } }, { requestId: "cb-1", hiuId: settings.hiuId, timestamp: null });
};

let logged: string[];
const originalLog = { log: console.log, warn: console.warn, error: console.error };

beforeEach(() => {
    now = T0;
    artefacts = new Map([[1, grantedArtefact()]]);
    requests = [];
    records = [];
    calls = [];
    audits = [];
    tasks = [];
    decrypts = 0;
    gatewayFault = null;
    storedBeforeCall = [];
    bytesReceived = new Map();
    listBudgets = [];
    settings = { hiuId: "IN3610001174", dataPushBaseUrl: "https://clinic.example.org", transferWindowMinutes: 20 };
    logged = [];
    for (const level of ["log", "warn", "error"] as const) {
        console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    }
});

afterEach(() => {
    Object.assign(console, originalLog);
});

// ---- health-information/request ----

test("requests exactly the granted range, with fresh key material, the push URL and X-HIU-ID, stored before sending", async () => {
    const service = makeService();
    await service.requestForArtefact(1);

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.host, "gateway");
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/api/hiecm/data-flow/v3/health-information/request");
    assert.deepEqual(call.headers, { "X-HIU-ID": "IN3610001174" });
    assert.deepEqual(storedBeforeCall, [true]);

    const hiRequest = (call.body as any).hiRequest;
    assert.equal(hiRequest.consent.id, "art-0001");
    // Never wider (nor narrower) than the grant: the granted instants, to the millisecond.
    assert.deepEqual(hiRequest.dateRange, { from: "2024-01-15T05:30:00.123Z", to: "2026-10-20T18:29:59.999Z" });
    assert.equal(hiRequest.keyMaterial.cryptoAlg, "ECDH");
    assert.equal(hiRequest.keyMaterial.curve, "Curve25519");
    assert.equal(hiRequest.keyMaterial.dhPublicKey.expiry, new Date(T0 + 30 * 60_000).toISOString());
    assert.equal(Buffer.from(hiRequest.keyMaterial.nonce, "base64").length, 32);
    // The nonce sits in keyMaterial (where HIPs read it) and at hiRequest level (the M3 schema's required list).
    assert.equal(hiRequest.nonce, hiRequest.keyMaterial.nonce);
    assert.match(hiRequest.dataPushUrl, /^https:\/\/clinic\.example\.org\/api\/v3\/hiu\/data-push\/[0-9a-f]{64}$/);

    const row = requests[0];
    assert.equal(row.hiRequestId, call.requestId);
    assert.equal(row.sessionStatus, "REQUESTED");
    assert.equal(row.pushTokenHash, sha256Hex(pushTokenOf()));
    assert.ok(!JSON.stringify(row).includes(pushTokenOf()), "the push token itself is never stored");
    assert.match(row.privateKey!, /^hiu1:t1:/);
    assert.equal(open(row.privateKey!, KEYS).length, 32);
    assert.equal(row.nonce, hiRequest.keyMaterial.nonce);
    assert.equal(row.keyExpiresAt.getTime(), T0 + 30 * 60_000);
    assert.equal(row.transferDeadline!.getTime(), T0 + 20 * 60_000);
    assert.deepEqual([row.dateFrom.getTime(), row.dateTo.getTime()], [GRANT_FROM.getTime(), GRANT_TO.getTime()]);
    assert.equal(audits.at(-1)!.event, "HI_REQUEST");
    assert.equal(audits.at(-1)!.outcome, "OK");
});

test("each request gets a new key pair, nonce and push token", async () => {
    const service = makeService();
    await service.requestForArtefact(1);
    requests[0].sessionStatus = "FAILED";
    await service.requestForArtefact(1);
    const [first, second] = calls.map((call) => (call.body as any).hiRequest);
    assert.notEqual(first.keyMaterial.dhPublicKey.keyValue, second.keyMaterial.dhPublicKey.keyValue);
    assert.notEqual(first.keyMaterial.nonce, second.keyMaterial.nonce);
    assert.notEqual(first.dataPushUrl, second.dataPushUrl);
});

for (const [name, change, kind] of [
    ["revoked", { status: "REVOKED" }, "conflict"],
    ["lapsed", { status: "EXPIRED" }, "conflict"],
    ["past its dataEraseAt", { dataEraseAt: new Date(T0 - 1) }, "conflict"],
    ["not yet fetched", { fetchedAt: null, dateFrom: null, dateTo: null }, "conflict"],
    ["of an unknown id", null, "not-found"],
] as const) {
    test(`an artefact ${name} is refused with no ABDM call and no stored request`, async () => {
        if (change) artefacts.set(1, grantedArtefact(change as Partial<HiuDataArtefact>));
        else artefacts.clear();
        await assert.rejects(makeService().requestForArtefact(1), (error: any) => error instanceof HiuError && error.kind === kind && !/expired/i.test(error.message));
        assert.equal(calls.length, 0);
        assert.equal(requests.length, 0);
    });
}

test("a second request while a transfer is open is refused with no call", async () => {
    const service = makeService();
    await service.requestForArtefact(1);
    await assert.rejects(service.requestForArtefact(1), (error: any) => error instanceof HiuError && error.kind === "conflict");
    assert.equal(calls.length, 1);
});

test("missing HIU settings answer not-configured with no call", async () => {
    settings = { ...settings, hiuId: "" };
    await assert.rejects(makeService().requestForArtefact(1), (error: any) => error instanceof HiuError && error.kind === "not-configured" && error.status === 503);
    settings = { ...settings, hiuId: "IN3610001174", dataPushBaseUrl: "" };
    await assert.rejects(makeService().requestForArtefact(1), (error: any) => error instanceof HiuError && error.kind === "not-configured");
    const unkeyed = new HiuDataFlowService({ store, audit, gateway, clock: () => now, atRestKeys: () => null, settings: () => ({ ...settings, dataPushBaseUrl: "https://x.org" }) });
    await assert.rejects(unkeyed.requestForArtefact(1), (error: any) => error instanceof HiuError && error.kind === "not-configured");
    assert.equal(calls.length, 0);
});

test("dataPushUrl stays within 255 characters of ABDM's allowed set, or nothing is sent", async () => {
    const service = makeService();
    await service.requestForArtefact(1);
    const url = hiRequestOf().hiRequest.dataPushUrl as string;
    assert.ok(url.length <= 255);
    assert.match(url, DATA_PUSH_URL_PATTERN);

    requests[0].sessionStatus = "FAILED";
    calls = [];
    settings = { ...settings, dataPushBaseUrl: `https://${"a".repeat(180)}.example.org` };
    await assert.rejects(service.requestForArtefact(1), (error: any) => error instanceof HiuError && error.kind === "not-configured");
    settings = { ...settings, dataPushBaseUrl: "https://clinic.example.org/push#x" };
    await assert.rejects(service.requestForArtefact(1), (error: any) => error instanceof HiuError && error.kind === "not-configured");
    assert.equal(calls.length, 0);
    assert.equal(requests.length, 1);
});

test("an ABDM refusal marks the request FAILED, drops the key and rethrows", async () => {
    gatewayFault = () => {
        throw new AbdmApiError({ status: 400, kind: "rejected", operation: "x", code: "ABDM-1063", message: "Date Range given is invalid" });
    };
    await assert.rejects(makeService().requestForArtefact(1), AbdmApiError);
    assert.equal(requests[0].sessionStatus, "FAILED");
    assert.equal(requests[0].privateKey, null);
    assert.match(requests[0].error!, /ABDM-1063/);
    assert.equal(audits.at(-1)!.outcome, "REJECTED");
});

const hiTimeout = () => new AbdmApiError({ status: 0, kind: "timeout", operation: "data-flow/health-information/request", message: "ABDM did not reply within 30 seconds." });

for (const [name, error] of [
    ["timed out", hiTimeout],
    ["lost its connection", () => new AbdmApiError({ status: 0, kind: "unavailable", operation: "x", message: "ABDM could not be reached." })],
] as const) {
    test(`a request whose call ${name} stays open with its key; the late on-request and the pages complete it, with a notify`, async () => {
        gatewayFault = () => { throw error(); };
        const service = makeService();
        await assert.rejects(service.requestForArtefact(1), AbdmApiError);
        assert.equal(requests[0].sessionStatus, "REQUESTED");
        assert.ok(requests[0].privateKey, "the key is kept: ABDM may have taken the request");
        assert.equal(requests[0].completedAt, null);
        assert.equal(audits.at(-1)!.outcome, "FAILED");

        gatewayFault = null;
        await service.onRequest({ hiRequest: { transactionId: TRANSACTION, sessionStatus: "REQUESTED" }, error: null, response: { requestId: requests[0].hiRequestId } }, { requestId: "cb-late", hiuId: settings.hiuId, timestamp: null });
        assert.equal(requests[0].transactionId, TRANSACTION);
        assert.equal((await service.acceptPush(pushTokenOf(), hipPage(1, 1, [{ reference: "CC-A", content: JSON.stringify(bundle("late")) }]))).status, 202);
        await settle();
        assert.equal(requests[0].sessionStatus, "RECEIVED");
        assert.equal(notifies().length, 1, "receipt is reported to ABDM");
    });
}

test("a request with no answer and no on-request is closed by its window without a notify", async () => {
    gatewayFault = () => { throw hiTimeout(); };
    const service = makeService();
    await assert.rejects(service.requestForArtefact(1), AbdmApiError);
    now = T0 + 21 * 60_000;
    await service.failTransfer(requests[0].id);
    assert.equal(requests[0].sessionStatus, "FAILED");
    assert.equal(requests[0].privateKey, null);
    assert.equal(notifies().length, 0);
});

test("a refusal does not fail a transfer that on-request already answered", async () => {
    const service = makeService();
    gatewayFault = async (call) => {
        // on-request (and the HIP's first page) beat the gateway's answer, which is then an error.
        await service.onRequest({ hiRequest: { transactionId: TRANSACTION, sessionStatus: "REQUESTED" }, error: null, response: { requestId: call.requestId } }, { requestId: "cb-early", hiuId: settings.hiuId, timestamp: null });
        throw new AbdmApiError({ status: 502, kind: "unavailable", operation: "x", message: "Bad gateway" });
    };
    await assert.rejects(service.requestForArtefact(1), AbdmApiError);
    assert.equal(requests[0].sessionStatus, "REQUESTED");
    assert.ok(requests[0].privateKey);
    gatewayFault = null;
    assert.equal((await service.acceptPush(pushTokenOf(), hipPage(1, 1, [{ reference: "CC-A", content: "{}" }]))).status, 202);
    await settle();
    assert.equal(notifies().length, 1);
});

test("on-request for a request already closed is not taken up, and is audited as ignored", async () => {
    gatewayFault = () => { throw new AbdmApiError({ status: 400, kind: "rejected", operation: "x", code: "ABDM-1063", message: "Date Range given is invalid" }); };
    const service = makeService();
    await assert.rejects(service.requestForArtefact(1), AbdmApiError);
    assert.equal(requests[0].sessionStatus, "FAILED");
    await service.onRequest({ hiRequest: { transactionId: TRANSACTION, sessionStatus: "REQUESTED" }, error: null, response: { requestId: requests[0].hiRequestId } }, { requestId: "cb", hiuId: settings.hiuId, timestamp: null });
    assert.equal(requests[0].transactionId, null);
    const last = audits.at(-1)!;
    assert.deepEqual([last.event, last.outcome, last.detail], ["ON_REQUEST", "IGNORED", "request already closed"]);
});

// ---- asking again ----

test("staff can ask again after a failed transfer, only for their hospital's artefact, and not while one is open", async () => {
    const service = makeService();
    await service.requestForArtefact(1);
    requests[0].sessionStatus = "FAILED";

    assert.deepEqual(await service.requestRecords(STAFF, 1), { artefactId: 1 });
    assert.equal(calls.length, 2);
    const asked = audits.filter((event) => event.event === "HI_REQUEST").at(-1)!;
    assert.equal(asked.staffUserId, STAFF.staffUserId);
    assert.equal(asked.outcome, "OK");

    await assert.rejects(service.requestRecords(STAFF, 1), (error: any) => error instanceof HiuError && error.kind === "conflict");
    await assert.rejects(service.requestRecords({ ...STAFF, hospitalId: 99 }, 1), (error: any) => error instanceof HiuError && error.kind === "not-found");
    await assert.rejects(service.requestRecords(STAFF, 2), (error: any) => error instanceof HiuError && error.kind === "not-found");
    artefacts.set(1, grantedArtefact({ status: "REVOKED" }));
    requests[1].sessionStatus = "FAILED";
    await assert.rejects(service.requestRecords(STAFF, 1), (error: any) => error instanceof HiuError && error.kind === "conflict");
    assert.equal(calls.length, 2);
});

test("asking again after the records were received is refused with no call, so no entry is stored twice", async () => {
    const service = makeService();
    await openTransfer(service);
    assert.equal((await service.acceptPush(pushTokenOf(), hipPage(1, 1, [{ reference: "CC-A", content: JSON.stringify(bundle("once")) }]))).status, 202);
    await settle();
    assert.equal(requests[0].sessionStatus, "RECEIVED");

    await assert.rejects(service.requestRecords(STAFF, 1), (error: any) => error instanceof HiuError && error.kind === "conflict" && error.status === 409 && !/expired/i.test(error.message));
    assert.equal(calls.filter((call) => call.path.endsWith("/health-information/request")).length, 1);
    assert.equal(requests.length, 1);
    const refused = audits.filter((event) => event.event === "HI_REQUEST").at(-1)!;
    assert.deepEqual([refused.outcome, refused.detail], ["REJECTED", "conflict"]);
    const view = await service.records(STAFF, 1);
    assert.equal(view.available && view.records.length, 1);
});

test("records show one transfer only: the received one, never a failed earlier copy or a repeat stored by older code", async () => {
    const service = makeService();
    await openTransfer(service);
    // A first transfer that failed part way, then a second that was received.
    assert.equal((await service.acceptPush(pushTokenOf(), hipPage(1, 2, [{ reference: "CC-A", content: JSON.stringify(bundle("partial")) }]))).status, 202);
    await settle();
    requests[0].sessionStatus = "FAILED";
    requests[0].privateKey = null;
    calls = [];
    await service.requestRecords(STAFF, 1);
    await service.onRequest({ hiRequest: { transactionId: `${TRANSACTION}-2`, sessionStatus: "REQUESTED" }, error: null, response: { requestId: requests[1].hiRequestId } }, { requestId: "cb-2", hiuId: settings.hiuId, timestamp: null });
    assert.equal((await service.acceptPush(pushTokenOf(), hipPage(1, 1, [{ reference: "CC-A", content: JSON.stringify(bundle("full")) }], `${TRANSACTION}-2`))).status, 202);
    await settle();
    assert.equal(requests[1].sessionStatus, "RECEIVED");
    // Older data: a repeat transfer stored before repeats were refused, failed after its first page.
    requests.push({ ...requests[1], id: 3, hiRequestId: "old-repeat", transactionId: "old-repeat", sessionStatus: "FAILED" });
    records.push({ ...records.at(-1)!, id: records.length + 1, dataRequestFk: 3 });

    const view = await service.records(STAFF, 1);
    assert.ok(view.available);
    if (view.available) assert.deepEqual(view.records.map((record) => (record.bundle as any).id), ["full"]);
    const partial = records.find((r) => r.dataRequestFk === 1)!;
    await assert.rejects(service.record(STAFF, 1, partial.id), (error: any) => error instanceof HiuError && error.kind === "not-found");
});

// ---- on-request ----

test("on-request stores the transaction id; an error fails the request and drops the key; unknown ids are dropped", async () => {
    const service = makeService();
    await openTransfer(service);
    assert.equal(requests[0].transactionId, TRANSACTION);
    assert.equal(requests[0].sessionStatus, "REQUESTED");
    assert.ok(requests[0].privateKey);

    await service.onRequest({ hiRequest: { transactionId: "other", sessionStatus: "REQUESTED" }, response: { requestId: "not-ours" } }, { requestId: "cb-2", hiuId: null, timestamp: null });
    assert.equal(requests[0].transactionId, TRANSACTION);
    assert.equal(audits.at(-1)!.outcome, "IGNORED");

    artefacts.set(2, grantedArtefact({ id: 2, consentArtefactId: "art-0002" }));
    await service.requestForArtefact(2);
    const second = requests[1];
    await service.onRequest({ hiRequest: null, error: { code: "ABDM-1001: ", message: "No data found" }, response: { requestId: second.hiRequestId } }, { requestId: "cb-3", hiuId: null, timestamp: null });
    assert.equal(requests[1].sessionStatus, "FAILED");
    assert.equal(requests[1].privateKey, null);
    assert.match(requests[1].error!, /ABDM-1001\)/);
});

test("on-request whose transaction id is not adopted (the request closed meanwhile) is audited as ignored, not OK", async () => {
    const service = makeService();
    await service.requestForArtefact(1);
    const adopt = store.adoptTransactionId;
    // The read saw the request open; the window sweep closed it before the claim ran.
    store.adoptTransactionId = async () => false;
    try {
        await service.onRequest({ hiRequest: { transactionId: TRANSACTION, sessionStatus: "REQUESTED" }, error: null, response: { requestId: requests[0].hiRequestId } }, { requestId: "cb", hiuId: settings.hiuId, timestamp: null });
    } finally {
        store.adoptTransactionId = adopt;
    }
    const last = audits.at(-1)!;
    assert.deepEqual([last.event, last.outcome, last.detail], ["ON_REQUEST", "IGNORED", "request already closed"]);
    assert.ok(!audits.some((event) => event.event === "ON_REQUEST" && event.outcome === "OK"));
});

test("on-request addressed to another HIU is dropped", async () => {
    const service = makeService();
    await service.requestForArtefact(1);
    await service.onRequest({ hiRequest: { transactionId: TRANSACTION, sessionStatus: "REQUESTED" }, response: { requestId: requests[0].hiRequestId } }, { requestId: "cb", hiuId: "SOMEONE-ELSE", timestamp: null });
    assert.equal(requests[0].transactionId, null);
});

// ---- data push: refusals before any decryption ----

test("pushes with a bad token, the wrong transaction, past the window or an oversize pageCount are refused before decrypting", async () => {
    const service = makeService();
    await openTransfer(service);
    const token = pushTokenOf();
    const good = hipPage(1, 1, [{ reference: "CC-A", content: JSON.stringify(bundle("a")) }]);

    assert.deepEqual(await service.acceptPush("not-a-token", good), { accepted: false, status: 404, reason: "Not found." });
    assert.equal((await service.acceptPush("ab".repeat(32), good)).status, 404);
    assert.equal((await service.acceptPush(token, { ...good, transactionId: "someone-elses" })).status, 400);
    assert.equal((await service.acceptPush(token, { ...good, pageCount: 201 })).status, 400);
    assert.equal((await service.acceptPush(token, { ...good, pageNumber: 2, pageCount: 1 })).status, 400);
    assert.equal((await service.acceptPush(token, { ...good, keyMaterial: { cryptoAlg: "ECDH" } })).status, 400);
    assert.equal((await service.acceptPush(token, { ...good, entries: "x" })).status, 400);
    assert.equal((await service.acceptPush(token, [])).status, 400);

    now = T0 + 20 * 60_000;
    const late = await service.acceptPush(token, good);
    assert.equal(late.status, 410);
    assert.ok(!/expired/i.test(late.reason!));

    await settle();
    assert.equal(decrypts, 0);
    assert.equal(records.length, 0);
    assert.equal(notifies().length, 0);
});

test("a pageCount that changes between pages is refused", async () => {
    const service = makeService();
    await openTransfer(service);
    const token = pushTokenOf();
    assert.equal((await service.acceptPush(token, hipPage(1, 3, [{ reference: "CC-A", content: "{}" }]))).status, 202);
    assert.equal((await service.acceptPush(token, hipPage(2, 4, [{ reference: "CC-A", content: "{}" }]))).status, 409);
    await settle();
    assert.equal(requests[0].pageCount, 3);
});

test("a push to a finished transfer is refused", async () => {
    const service = makeService();
    await openTransfer(service);
    const token = pushTokenOf();
    assert.equal((await service.acceptPush(token, hipPage(1, 1, [{ reference: "CC-A", content: "{}" }]))).status, 202);
    await settle();
    assert.equal(requests[0].sessionStatus, "RECEIVED");
    assert.equal((await service.acceptPush(token, hipPage(1, 1, [{ reference: "CC-A", content: "{}" }]))).status, 409);
});

test("the push address is checked on its own, before any body: unknown, ended, past its window, or open", async () => {
    const service = makeService();
    await openTransfer(service);
    const token = pushTokenOf();
    assert.equal(await service.pushAddressProblem(token), null);
    assert.equal((await service.pushAddressProblem("not-a-token"))!.status, 404);
    assert.equal((await service.pushAddressProblem("ab".repeat(32)))!.status, 404);
    now = T0 + 20 * 60_000;
    assert.equal((await service.pushAddressProblem(token))!.status, 410);
    now = T0;
    requests[0].sessionStatus = "FAILED";
    assert.equal((await service.pushAddressProblem(token))!.status, 409);
    const unkeyed = new HiuDataFlowService({ store, audit, gateway, clock: () => now, atRestKeys: () => null, settings: () => settings });
    assert.equal((await unkeyed.pushAddressProblem(token))!.status, 503);
});

for (const [name, close] of [
    ["the consent is revoked", () => { artefacts.set(1, { ...artefacts.get(1)!, status: "REVOKED", recordsPurgedAt: new Date(now) }); }],
    ["the transfer times out", () => { requests[0].notifiedAt = new Date(now); requests[0].sessionStatus = "FAILED"; requests[0].privateKey = null; }],
] as const) {
    test(`a page being decrypted when ${name} is dropped, not stored`, async () => {
        const closing: HiuDataStore = { ...store, async addPage(input) { close(); return store.addPage(input); } };
        const service = new HiuDataFlowService({ store: closing, audit, gateway, clock: () => now, crypto, atRestKeys: () => KEYS, settings: () => settings, runInBackground: (task) => { tasks.push(task()); } });
        await openTransfer(service);
        assert.equal((await service.acceptPush(pushTokenOf(), hipPage(1, 1, [{ reference: "CC-A", content: JSON.stringify(bundle("late")) }]))).status, 202);
        await settle();
        assert.equal(records.length, 0, "nothing decrypted is kept");
        assert.equal(requests[0].pagesReceived, 0);
        assert.equal(notifies().length, 0, "no RECEIVED notify for a page that was not kept");
        assert.ok(!audits.some((event) => event.event === "PAGE_RECEIVED"));
        assert.ok(logged.some((line) => line.includes("page dropped")));
    });
}

test("a transfer is capped in total: a page past the cap is refused 413, and a repeated page is not counted twice", async () => {
    settings = { ...settings, maxTransferMb: 2_000 / (1024 * 1024) };
    const service = makeService();
    await openTransfer(service);
    const token = pushTokenOf();
    const first = hipPage(1, 3, [{ reference: "CC-A", content: "x".repeat(600) }]);
    assert.equal((await service.acceptPush(token, first)).status, 202);
    await settle();
    assert.equal((await service.acceptPush(token, first)).status, 202, "a page already stored is answered as taken");
    assert.equal((await service.acceptPush(token, hipPage(2, 3, [{ reference: "CC-A", content: "y".repeat(600) }]))).status, 202);
    const over = await service.acceptPush(token, hipPage(3, 3, [{ reference: "CC-B", content: "z".repeat(600) }]));
    assert.equal(over.status, 413);
    assert.ok(!/expired/i.test(over.reason!));
    await settle();
    assert.equal(requests[0].pagesReceived, 2);
});

test("records come with content only up to a fixed size per answer; the rest is read one record at a time", async () => {
    const service = makeService();
    await openTransfer(service);
    await service.acceptPush(pushTokenOf(), hipPage(1, 1, [{ reference: "CC-A", content: JSON.stringify(bundle("one")) }, { reference: "CC-B", content: JSON.stringify(bundle("two")) }]));
    await settle();

    const full = await service.records(STAFF, 1);
    assert.deepEqual(listBudgets, [HIU_RECORDS_RESPONSE_MAX_BYTES]);
    assert.ok(full.available && full.omitted === 0 && full.records.every((record) => !record.contentOmitted));

    // A budget that fits only the first record's content.
    const budgeted: HiuDataStore = { ...store, listRecords: (artefactFk, at) => store.listRecords(artefactFk, at, records[0].content!.length * 2) };
    const small = new HiuDataFlowService({ store: budgeted, audit, gateway, clock: () => now, crypto, atRestKeys: () => KEYS, settings: () => settings });
    const view = await small.records(STAFF, 1);
    assert.ok(view.available);
    if (view.available) {
        assert.equal(view.omitted, 1);
        assert.deepEqual(view.records.map((record) => [record.contentOmitted, record.bundle !== null]), [[false, true], [true, false]]);
        assert.equal(view.records[1].careContextReference, "CC-B", "an omitted record still says what it is");
    }

    const one = await small.record(STAFF, 1, records[1].id);
    assert.ok(one.available);
    if (one.available) {
        assert.equal(one.records.length, 1);
        assert.deepEqual(one.records[0].bundle, bundle("two"));
        assert.equal(one.records[0].contentOmitted, false);
    }
    assert.equal(audits.filter((event) => event.event === "RECORD_VIEWED").at(-1)!.detail, `record ${records[1].id}`);

    // Same checks as the list: another hospital, an unknown record, a revoked consent.
    await assert.rejects(small.record({ ...STAFF, hospitalId: 99 }, 1, records[1].id), (error: any) => error instanceof HiuError && error.kind === "not-found");
    await assert.rejects(small.record(STAFF, 1, 9_999), (error: any) => error instanceof HiuError && error.kind === "not-found");
    artefacts.set(1, { ...artefacts.get(1)!, status: "REVOKED" });
    assert.deepEqual(await small.record(STAFF, 1, records[1].id), { available: false, artefactId: 1, reason: "REVOKED" });
});

// ---- data push: round trip ----

test("round trip with a fake HIP: decrypted, verified, sealed, notified RECEIVED once, key dropped, viewable", async () => {
    const service = makeService();
    await openTransfer(service);
    const content = JSON.stringify(bundle("op-1"));
    const page = hipPage(1, 1, [{ reference: "CC-A", content }, { reference: "CC-B", content: JSON.stringify(bundle("op-2")) }]);

    const answer = await service.acceptPush(pushTokenOf(), page);
    assert.deepEqual(answer, { accepted: true, status: 202 });
    // Nothing is decrypted before the HIP has its answer.
    assert.equal(decrypts, 0);
    await settle();

    assert.equal(decrypts, 2);
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => record.checksumOk && record.content!.startsWith("hiu1:t1:") && record.careContextReference!.startsWith("hiu1:t1:")));
    assert.equal(open(records[0].content!, KEYS).toString("utf8"), content);
    assert.deepEqual(records.map((record) => record.deleteAt), [ERASE_AT, ERASE_AT]);

    const sent = notifies();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].headers, undefined, "notify carries no X-HIU-ID");
    assert.equal(sent[0].requestId, requests[0].notifyRequestId);
    assert.deepEqual((sent[0].body as any).notification, {
        consentId: "art-0001",
        transactionId: TRANSACTION,
        doneAt: new Date(T0).toISOString(),
        notifier: { type: "HIU", id: "IN3610001174" },
        statusNotification: {
            sessionStatus: "RECEIVED",
            hipId: "IN2810014366",
            statusResponses: [
                { careContextReference: "CC-A", hiStatus: "OK", description: "Data received successfully" },
                { careContextReference: "CC-B", hiStatus: "OK", description: "Data received successfully" },
            ],
        },
    });
    assert.equal(requests[0].sessionStatus, "RECEIVED");
    assert.equal(requests[0].privateKey, null);
    assert.ok(requests[0].completedAt);
    assert.ok(audits.some((event) => event.event === "PAGE_RECEIVED" && event.outcome === "OK" && event.detail === "page 1 of 1, 2 entries, 0 failed"));
    assert.ok(audits.some((event) => event.event === "DATA_NOTIFY_SENT" && event.outcome === "RECEIVED"));

    const view = await service.records(STAFF, 1);
    assert.equal(view.available, true);
    if (view.available) {
        assert.equal(view.deleteAt, ERASE_AT.toISOString());
        assert.deepEqual(view.records.map((record) => [record.careContextReference, record.checksumOk, record.raw]), [["CC-A", true, null], ["CC-B", true, null]]);
        assert.deepEqual(view.records[0].bundle, bundle("op-1"));
    }
    const viewed = audits.at(-1)!;
    assert.equal(viewed.event, "RECORD_VIEWED");
    assert.equal(viewed.staffUserId, STAFF.staffUserId);
    assert.equal(viewed.artefactId, "art-0001");

    // No secret, content or care-context reference reached a log line.
    const hiRequest = hiRequestOf().hiRequest;
    const text = logged.join("\n");
    for (const secret of [pushTokenOf(), hiRequest.keyMaterial.nonce, hiRequest.keyMaterial.dhPublicKey.keyValue, page.keyMaterial.nonce, "CC-A", "op-1", page.entries[0].content]) {
        assert.ok(!text.includes(secret), "a log line carried a secret or record data");
    }
    assert.ok(text.includes(TRANSACTION));
});

for (const base of [0, 1]) {
    test(`notify is sent once, only after every page, with ${base}-based page numbers, out of order and with a repeat`, async () => {
        const service = makeService();
        await openTransfer(service);
        const token = pushTokenOf();
        const pages = [0, 1, 2].map((index) => hipPage(index + base, 3, [{ reference: `CC-${index}`, content: JSON.stringify(bundle(`p${index}`)) }]));

        assert.equal((await service.acceptPush(token, pages[2])).status, 202);
        await settle();
        assert.equal((await service.acceptPush(token, pages[0])).status, 202);
        assert.equal((await service.acceptPush(token, pages[0])).status, 202, "a repeated page is still answered 202");
        await settle();
        assert.equal(notifies().length, 0, "no notify before every page");
        assert.equal(requests[0].pagesReceived, 2);
        assert.equal(requests[0].sessionStatus, "RECEIVING");

        assert.equal((await service.acceptPush(token, pages[1])).status, 202);
        await settle();
        assert.equal(notifies().length, 1);
        assert.equal(records.length, 3, "the repeated page stored nothing");
        assert.equal(requests[0].pagesReceived, 3);
        assert.equal(requests[0].sessionStatus, "RECEIVED");
        assert.equal(requests[0].privateKey, null);
        const statuses = (notifies()[0].body as any).notification.statusNotification.statusResponses;
        assert.deepEqual(statuses.map((item: any) => item.hiStatus), ["OK", "OK", "OK", "ERRORED", "ERRORED"]);
        assert.deepEqual(statuses.slice(3).map((item: any) => item.careContextReference), ["CC-A", "CC-B"], "granted care contexts that sent nothing are ERRORED");
    });
}

test("two copies of the last page arriving together still give one notify", async () => {
    const service = makeService();
    await openTransfer(service);
    const token = pushTokenOf();
    const last = hipPage(1, 1, [{ reference: "CC-A", content: "{}" }]);
    await service.acceptPush(token, last);
    await service.acceptPush(token, last);
    await settle();
    assert.equal(notifies().length, 1);
    assert.equal(records.length, 1);
});

test("a checksum mismatch marks that care context ERRORED and the transfer FAILED; others stay OK", async () => {
    const service = makeService();
    await openTransfer(service);
    const page = hipPage(1, 1, [
        { reference: "CC-A", content: JSON.stringify(bundle("good")) },
        { reference: "CC-B", content: JSON.stringify(bundle("bad")), checksum: checksumOf("something else") },
    ]);
    await service.acceptPush(pushTokenOf(), page);
    await settle();

    const notification = (notifies()[0].body as any).notification;
    assert.equal(notification.statusNotification.sessionStatus, "FAILED");
    assert.deepEqual(notification.statusNotification.statusResponses.map((item: any) => [item.careContextReference, item.hiStatus]), [["CC-A", "OK"], ["CC-B", "ERRORED"]]);
    assert.equal(records[1].checksumOk, false);
    assert.equal(records[1].content, null, "an unverified entry's content is not kept");
    assert.equal(requests[0].sessionStatus, "FAILED");
    assert.equal(requests[0].privateKey, null);
    assert.ok(audits.some((event) => event.event === "DECRYPT_FAIL"));
});

test("an entry that does not decrypt, and a link entry with no content, are ERRORED", async () => {
    const service = makeService();
    await openTransfer(service);
    const page = hipPage(1, 1, [{ reference: "CC-A", content: "{}" }, { reference: "CC-B" }]);
    (page.entries[0] as { content?: string }).content = randomBytes(40).toString("base64");
    await service.acceptPush(pushTokenOf(), page);
    await settle();
    const statuses = (notifies()[0].body as any).notification.statusNotification;
    assert.equal(statuses.sessionStatus, "FAILED");
    assert.deepEqual(statuses.statusResponses.map((item: any) => item.hiStatus), ["ERRORED", "ERRORED"]);
});

test("a push that beats on-request adopts its transaction id", async () => {
    const service = makeService();
    await service.requestForArtefact(1);
    assert.equal((await service.acceptPush(pushTokenOf(), hipPage(1, 1, [{ reference: "CC-A", content: "{}" }]))).status, 202);
    await settle();
    assert.equal(requests[0].transactionId, TRANSACTION);
    assert.equal(notifies().length, 1);
    // The late on-request is a repeat and changes nothing.
    await service.onRequest({ hiRequest: { transactionId: TRANSACTION, sessionStatus: "REQUESTED" }, response: { requestId: requests[0].hiRequestId } }, { requestId: "cb", hiuId: null, timestamp: null });
    assert.equal(requests[0].sessionStatus, "RECEIVED");
});

test("a page with no entries still counts toward pageCount", async () => {
    const service = makeService();
    await openTransfer(service);
    await service.acceptPush(pushTokenOf(), hipPage(1, 2, [{ reference: "CC-A", content: "{}" }]));
    await service.acceptPush(pushTokenOf(), hipPage(2, 2, []));
    await settle();
    assert.equal(notifies().length, 1);
    const view = await service.records(STAFF, 1);
    assert.ok(view.available && view.records.length === 1, "the empty page's marker is not a record");
});

// ---- timeout ----

test("a transfer past its window is notified FAILED once, even with two sweeps at once; missing care contexts ERRORED; key dropped", async () => {
    const service = makeService();
    await openTransfer(service);
    await service.acceptPush(pushTokenOf(), hipPage(1, 2, [{ reference: "CC-A", content: JSON.stringify(bundle("only")) }]));
    await settle();
    assert.equal(notifies().length, 0);

    now = T0 + 21 * 60_000;
    const timedOut = async (at: Date) => requests.filter((row) => !row.notifiedAt && ["REQUESTED", "RECEIVING"].includes(row.sessionStatus) && row.transferDeadline! <= at).map((row) => row.id);
    const maintenanceStore = {
        purgeRecords: async () => [],
        clearPrivateKeys: async () => 0,
        listTimedOutTransfers: timedOut,
        closeStaleClaimed: async () => 0,
    };
    const instances = [0, 1].map(() => new HiuMaintenanceService({ store: maintenanceStore, dataFlow: service, audit, clock: () => now }));
    await Promise.all(instances.map((instance) => instance.runOnce()));

    assert.equal(notifies().length, 1);
    const notification = (notifies()[0].body as any).notification;
    assert.equal(notification.statusNotification.sessionStatus, "FAILED");
    assert.deepEqual(notification.statusNotification.statusResponses.map((item: any) => [item.careContextReference, item.hiStatus]), [["CC-A", "OK"], ["CC-B", "ERRORED"]]);
    assert.equal(requests[0].sessionStatus, "FAILED");
    assert.equal(requests[0].privateKey, null);
    assert.match(requests[0].error!, /1 of 2/);
    assert.ok(!/expired/i.test(requests[0].error!));
    assert.equal(audits.filter((event) => event.event === "TRANSFER_TIMEOUT").length, 1);

    // A late page after the timeout is refused.
    assert.equal((await service.acceptPush(pushTokenOf(), hipPage(2, 2, [{ reference: "CC-B", content: "{}" }]))).status, 409);
});

test("a transfer ABDM never acknowledged is closed FAILED without a notify", async () => {
    const service = makeService();
    await service.requestForArtefact(1);
    now = T0 + 21 * 60_000;
    await service.failTransfer(requests[0].id);
    assert.equal(requests[0].sessionStatus, "FAILED");
    assert.equal(requests[0].privateKey, null);
    assert.equal(notifies().length, 0);
});

// ---- staff read ----

test("records are refused after a revoke, after dataEraseAt, to another hospital, and before any arrive", async () => {
    const service = makeService();
    assert.deepEqual(await service.records(STAFF, 1), { available: false, artefactId: 1, reason: "NOT_RECEIVED" });

    await openTransfer(service);
    await service.acceptPush(pushTokenOf(), hipPage(1, 1, [{ reference: "CC-A", content: JSON.stringify(bundle("x")) }]));
    await settle();
    assert.equal((await service.records(STAFF, 1)).available, true);

    await assert.rejects(service.records({ ...STAFF, hospitalId: 99 }, 1), (error: any) => error instanceof HiuError && error.kind === "not-found");

    now = ERASE_AT.getTime();
    assert.deepEqual(await service.records(STAFF, 1), { available: false, artefactId: 1, reason: "ERASED" });
    now = T0;

    artefacts.set(1, { ...artefacts.get(1)!, status: "REVOKED" });
    assert.deepEqual(await service.records(STAFF, 1), { available: false, artefactId: 1, reason: "REVOKED" });
    artefacts.set(1, { ...artefacts.get(1)!, status: "EXPIRED" });
    assert.deepEqual(await service.records(STAFF, 1), { available: false, artefactId: 1, reason: "EXPIRED" });
    artefacts.set(1, { ...artefacts.get(1)!, status: "DENIED" });
    assert.deepEqual(await service.records(STAFF, 1), { available: false, artefactId: 1, reason: "NOT_GRANTED" });
    artefacts.set(1, { ...artefacts.get(1)!, status: "GRANTED", recordsPurgedAt: new Date(T0) });
    assert.deepEqual(await service.records(STAFF, 1), { available: false, artefactId: 1, reason: "ERASED" });
    assert.equal(audits.filter((event) => event.event === "RECORD_VIEWED").length, 1, "only a read that returned records is audited as a view");
});

test("content that is not JSON is returned as raw text", async () => {
    const service = makeService();
    await openTransfer(service);
    await service.acceptPush(pushTokenOf(), hipPage(1, 1, [{ reference: "CC-A", content: "plain text note" }]));
    await settle();
    const view = await service.records(STAFF, 1);
    assert.ok(view.available);
    if (view.available) {
        assert.equal(view.records[0].bundle, null);
        assert.equal(view.records[0].raw, "plain text note");
    }
});
