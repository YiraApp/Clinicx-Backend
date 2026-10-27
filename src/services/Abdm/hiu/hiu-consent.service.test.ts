import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import { AbdmFacilityDirectory } from "../abdm-facilities.service.js";
import { AbdmApiError, type AbdmCall } from "../abdm-gateway.service.js";
import { atRestKeysFrom, open } from "./hiu-at-rest.js";
import type { HiuAuditEventInput } from "./hiu-audit.js";
import { HiuError } from "./hiu-enums.js";
import {
    ConsentInitUnansweredError,
    HiuConsentService,
    artefactStage,
    requestStatusFrom,
    type ArtefactWithTransfer,
    type ConsentRequestRow,
    type HiuConsentStore,
    type HiuDirectory,
    type HiuSettings,
    type NewConsentRequestInput,
    type StaffContext,
} from "./hiu-consent.service.js";

const PATIENT = "11111111-1111-1111-1111-111111111111";
const OTHER_PATIENT = "33333333-3333-3333-3333-333333333333";
const STAFF = "22222222-2222-2222-2222-222222222222";
const HIU_ID = "IN3610001174";
/** Hospital 20's own HIU (another tenant on the same deployment). */
const HIU_B = "IN3610002222";
const B_PATIENT = "44444444-4444-4444-4444-444444444444";
const B_CONSENT_REQUEST = "eeeeeeee-0000-4000-8000-00000000000e";
const B_ARTEFACT = "ffffffff-0000-4000-8000-00000000000f";
const ARTEFACT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ARTEFACT_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const CONSENT_REQUEST = "cccccccc-0000-4000-8000-00000000000c";
const ctx: StaffContext = { staffUserId: STAFF, hospitalId: 19, organizationId: 7 };
const otherHospital: StaffContext = { staffUserId: STAFF, hospitalId: 20, organizationId: 7 };
const keys = atRestKeysFrom({ key: randomBytes(32).toString("base64"), keyId: "k1" })!;

let now: number;
let ids: number;
let settings: HiuSettings;
/** Each hospital's HIU, as AbdmFacilities gives it. */
let hius: Map<number, { id: string; hospitalId: number; name: string }>;
let pushBase: string;
let requests: (ConsentRequestRow & { organizationId: number | null })[];
let artefacts: ArtefactWithTransfer[];
let records: { artefactFk: number }[];
let privateKeys: Map<number, string | null>;
let calls: { call: AbdmCall; seen: { request?: ConsentRequestRow; artefact?: ArtefactWithTransfer } }[];
let audits: HiuAuditEventInput[];
let requested: number[];
let gatewayFault: ((call: AbdmCall) => Error | null | Promise<Error | null>) | null;
/** Per artefact: consent/fetch calls claimed, and when its fetch claim last changed (UpdatedAt). */
let fetchAttempts: Map<number, number>;
let touchedAt: Map<number, number>;
/** The open-request lock: each key's queue of waiting raises. */
let locks: Map<string, Promise<unknown>>;
let requesterFault: boolean;
let service: HiuConsentService;

const patients = new Map([
    [PATIENT, { hospitalId: 19, name: "Asha Kumari", abhaAddress: "asha.kumari@sbx", abhaNumber: "91-1111-2222-3333" }],
    [OTHER_PATIENT, { hospitalId: 19, name: "No Abha", abhaAddress: null as string | null, abhaNumber: null as string | null }],
    [B_PATIENT, { hospitalId: 20, name: "Ravi B", abhaAddress: "ravi.b@sbx" as string | null, abhaNumber: "91-4444-5555-6666" as string | null }],
]);

const directory: HiuDirectory = {
    async hiu(hospitalId) { return (hospitalId && hius.get(hospitalId)) || null; },
    async hiuById(hiuId) { return [...hius.values()].find((hiu) => hiu.id === hiuId) ?? null; },
};

const withName = (row: ConsentRequestRow): ConsentRequestRow => ({
    ...row,
    patientName: patients.get(row.patientUserId)?.name ?? null,
    patientAbhaNumber: patients.get(row.patientUserId)?.abhaNumber ?? null,
    artefactCount: artefacts.filter((artefact) => artefact.consentRequestFk === row.id).length,
    hiTypes: [...row.hiTypes],
});

const store: HiuConsentStore = {
    async findPatient(userId, hospitalId) {
        const patient = patients.get(userId);
        return patient && patient.hospitalId === hospitalId ? { userId, name: patient.name, abhaAddress: patient.abhaAddress, abhaNumber: patient.abhaNumber } : null;
    },
    async staffName() { return "Dr Rao"; },
    async findOpenRequests({ hospitalId, patientUserId, purposeCode }) {
        return requests.filter((row) => row.hospitalId === hospitalId && row.patientUserId === patientUserId && row.purposeCode === purposeCode
            && ["SENDING", "REQUESTED"].includes(row.status)).map(withName);
    },
    async withOpenRequestLock(key, work) {
        // Like sp_getapplock: a second raise of the same need waits until the first has finished.
        const name = `${key.hospitalId}|${key.patientUserId}|${key.purposeCode}`;
        const before = locks.get(name) ?? Promise.resolve();
        const run = before.then(work, work);
        locks.set(name, run.catch(() => undefined));
        return run;
    },
    async createRequest(row) {
        // A database round trip: another raise can interleave here.
        await new Promise((resolve) => setImmediate(resolve));
        const id = requests.length + 1;
        requests.push({ ...row, id, consentRequestId: null, statusRequestId: null, abdmErrorCode: null, abdmError: null, createdAt: row.statusAt, patientName: null, artefactCount: 0 });
        return id;
    },
    async updateRequest(id, changes) { Object.assign(requests.find((row) => row.id === id)!, changes); },
    async updateSendingRequest(id, changes) {
        const row = requests.find((r) => r.id === id)!;
        if (row.status !== "SENDING" || row.consentRequestId) return false;
        Object.assign(row, changes);
        return true;
    },
    async failStaleSending({ createdBefore, at, message }) {
        const due = requests.filter((row) => row.status === "SENDING" && !row.consentRequestId && new Date(row.createdAt).getTime() <= createdBefore.getTime());
        for (const row of due) Object.assign(row, { status: "FAILED", statusAt: at, abdmErrorCode: null, abdmError: message });
        return due.map((row) => ({ id: row.id, hospitalId: row.hospitalId, initRequestId: row.initRequestId }));
    },
    async findRequest(hospitalId, id) {
        const row = requests.find((r) => r.id === id && r.hospitalId === hospitalId);
        return row ? withName(row) : null;
    },
    async findRequestById(id) { const row = requests.find((r) => r.id === id); return row ? withName(row) : null; },
    async findRequestByInitRequestId(requestId) { const row = requests.find((r) => r.initRequestId === requestId); return row ? withName(row) : null; },
    async findRequestByStatusRequestId(requestId) { const row = requests.find((r) => r.statusRequestId === requestId); return row ? withName(row) : null; },
    async findRequestByConsentRequestId(id) { const row = requests.find((r) => r.consentRequestId === id); return row ? withName(row) : null; },
    async listRequests({ hospitalId, page, pageSize, status }) {
        const rows = requests.filter((row) => row.hospitalId === hospitalId && (!status || row.status === status)).reverse();
        return { rows: rows.slice((page - 1) * pageSize, page * pageSize).map(withName), total: rows.length };
    },
    async listArtefacts(fk) {
        return artefacts.filter((artefact) => artefact.consentRequestFk === fk)
            .map((artefact) => ({ ...artefact, recordCount: records.filter((record) => record.artefactFk === artefact.id).length }));
    },
    async findArtefactsByConsentArtefactIds(list) { return artefacts.filter((artefact) => list.includes(artefact.consentArtefactId)).map((a) => ({ ...a })); },
    async findArtefactByFetchRequestId(requestId) { const artefact = artefacts.find((a) => a.fetchRequestId === requestId); return artefact ? { ...artefact } : null; },
    async addArtefacts({ consentRequestFk, hospitalId, consentArtefactIds, at, status = "GRANTED" }) {
        for (const consentArtefactId of consentArtefactIds) {
            if (artefacts.some((artefact) => artefact.consentArtefactId === consentArtefactId)) continue;
            artefacts.push({
                id: ++ids, consentArtefactId, consentRequestFk, hospitalId, hipId: null, hipName: null, status, statusAt: at,
                hiTypes: null, dateFrom: null, dateTo: null, dataEraseAt: null, accessMode: null, fetchRequestId: null, fetchedAt: null,
                recordsPurgedAt: status === "GRANTED" ? null : at, transfer: null, recordCount: 0,
            });
            touchedAt.set(ids, at.getTime());
        }
    },
    async claimFetch(id, requestId, at) {
        const artefact = artefacts.find((a) => a.id === id)!;
        if (artefact.fetchRequestId || artefact.fetchedAt || artefact.status !== "GRANTED") return false;
        artefact.fetchRequestId = requestId;
        fetchAttempts.set(id, (fetchAttempts.get(id) ?? 0) + 1);
        touchedAt.set(id, at.getTime());
        return true;
    },
    async releaseFetch(id, requestId) {
        const artefact = artefacts.find((a) => a.id === id)!;
        if (artefact.fetchRequestId === requestId) {
            artefact.fetchRequestId = null;
            touchedAt.set(id, now);
        }
    },
    async listFetchRetries({ staleBefore, maxAttempts, limit }) {
        return artefacts.filter((a) => a.status === "GRANTED" && !a.fetchedAt && !a.recordsPurgedAt
            && (fetchAttempts.get(a.id) ?? 0) < maxAttempts && (touchedAt.get(a.id) ?? 0) <= staleBefore.getTime())
            .slice(0, limit).map((a) => ({ ...a }));
    },
    async reclaimFetch({ artefactId, previousRequestId, requestId, at, staleBefore, maxAttempts }) {
        const artefact = artefacts.find((a) => a.id === artefactId)!;
        if (artefact.status !== "GRANTED" || artefact.fetchedAt || artefact.recordsPurgedAt) return false;
        if ((fetchAttempts.get(artefactId) ?? 0) >= maxAttempts || (touchedAt.get(artefactId) ?? 0) > staleBefore.getTime()) return false;
        if (artefact.fetchRequestId !== previousRequestId) return false;
        artefact.fetchRequestId = requestId;
        fetchAttempts.set(artefactId, (fetchAttempts.get(artefactId) ?? 0) + 1);
        touchedAt.set(artefactId, at.getTime());
        return true;
    },
    async saveFetchedDetail(id, detail) {
        const artefact = artefacts.find((a) => a.id === id)!;
        if (artefact.fetchedAt || artefact.status !== "GRANTED") return false;
        Object.assign(artefact, detail);
        savedCareContexts.set(id, detail.careContexts);
        return true;
    },
    async endArtefact(id, status, at) {
        const before = records.length;
        records = records.filter((record) => record.artefactFk !== id);
        privateKeys.set(id, null);
        Object.assign(artefacts.find((a) => a.id === id)!, { status, statusAt: at, recordsPurgedAt: at });
        return before - records.length;
    },
    async listEvents({ hospitalId, consentRequestId, requestIds, artefactIds }) {
        return audits.filter((event) => event.hospitalId === hospitalId && ((consentRequestId && event.consentRequestId === consentRequestId)
            || (event.requestId && requestIds.includes(event.requestId)) || (event.artefactId && artefactIds.includes(event.artefactId))))
            .map((event) => ({ at: new Date(now), event: event.event, outcome: event.outcome }));
    },
};
const savedCareContexts = new Map<number, string | null>();

const gateway = {
    async call<T>(call: AbdmCall): Promise<T> {
        assert.equal(call.host, "gateway");
        assert.ok(call.requestId, "every HIU call passes its own REQUEST-ID");
        // What the store held the moment the call went out.
        calls.push({
            call,
            seen: {
                request: requests.find((row) => row.initRequestId === call.requestId || row.statusRequestId === call.requestId),
                artefact: artefacts.find((artefact) => artefact.fetchRequestId === call.requestId),
            },
        });
        const fault = await gatewayFault?.(call);
        if (fault) throw fault;
        return {} as T;
    },
};

const pathsCalled = () => calls.map(({ call }) => call.path.replace("/api/hiecm/consent/v3/", ""));

const input = (overrides: Partial<NewConsentRequestInput> & Record<string, unknown> = {}): NewConsentRequestInput => ({
    patientUserId: PATIENT,
    purposeCode: "CAREMGT",
    hiTypes: ["Prescription", "OPConsultation"],
    dateFrom: "2026-01-01",
    dateTo: "2026-10-26",
    dataEraseAt: "2026-12-31T23:59:00+05:30",
    accessMode: "VIEW",
    ...overrides,
} as NewConsentRequestInput);

const headers = (requestId: string | null) => ({ requestId, hiuId: HIU_ID, timestamp: new Date(now).toISOString() });

/** Raises a request and lets on-init answer it, as ABDM would. */
const raised = async (): Promise<ConsentRequestRow> => {
    const summary = await service.create(ctx, input());
    const row = requests.find((r) => r.id === summary.id)!;
    await service.onInit({ consentRequest: { id: CONSENT_REQUEST }, error: null, response: { requestId: row.initRequestId } }, headers("cb-init"));
    return row;
};

const notify = (status: string, artefactIds: string[], requestId = `notify-${status}`, consentRequestId: string | null = CONSENT_REQUEST) =>
    service.notify({
        notification: { consentRequestId, status, reason: null, consentArtefacts: artefactIds.map((id) => ({ id })) },
    }, headers(requestId));

const onFetchBody = (requestId: string, consentId: string, overrides: Record<string, any> = {}) => ({
    consent: {
        status: "GRANTED",
        consentDetail: {
            schemaVersion: "v3",
            consentId,
            createdAt: "2026-10-26T04:00:00.000Z",
            lastUpdated: "2026-10-26T04:00:00.000Z",
            patient: { id: "asha.kumari@sbx" },
            hip: { id: "HIP-1", name: "City Lab", type: "HIP" },
            hiu: { id: HIU_ID, name: "A A Hospital" },
            consentManager: { id: "sbx" },
            purpose: { text: "Care Management", code: "CAREMGT", refUri: "x" },
            hiTypes: ["Prescription"],
            careContexts: [{ patientReference: "PR-1", careContextReference: "CC-SECRET-1" }],
            permission: { accessMode: "VIEW", dateRange: { from: "2026-03-01T00:00:00.000Z", to: "2026-09-30T00:00:00.000Z" } },
            dataEraseAt: "2026-11-30T00:00:00.000Z",
            frequency: { unit: "HOUR", value: 1, repeats: 0 },
            ...overrides,
        },
        signature: "sig==",
    },
    error: null,
    response: { requestId },
});

beforeEach(() => {
    now = Date.parse("2026-10-26T06:00:00.000Z");
    ids = 100;
    settings = { configured: true, abhaAddressSuffix: "@sbx" };
    hius = new Map([[19, { id: HIU_ID, hospitalId: 19, name: "A A Hospital" }], [20, { id: HIU_B, hospitalId: 20, name: "B B Clinic" }]]);
    pushBase = "https://clinic.example.org";
    requests = [];
    artefacts = [];
    records = [];
    privateKeys = new Map();
    calls = [];
    audits = [];
    requested = [];
    gatewayFault = null;
    requesterFault = false;
    fetchAttempts = new Map();
    touchedAt = new Map();
    locks = new Map();
    savedCareContexts.clear();
    let next = 0;
    service = new HiuConsentService(store, {
        gateway,
        audit: { record: async (event) => { audits.push(event); } },
        clock: () => now,
        settings: () => settings,
        directory,
        pushBaseUrl: async () => pushBase,
        atRestKeys: () => keys,
        newId: () => `req-${++next}`,
        requester: {
            async requestForArtefact(id) {
                requested.push(id);
                if (requesterFault) throw new Error("data flow down");
            },
        },
    });
});

const assertRefused = async (promise: Promise<unknown>, kind: string, status: number) => {
    await assert.rejects(promise, (error: any) => {
        assert.ok(error instanceof HiuError, `expected HiuError, got ${error?.name}`);
        assert.equal(error.kind, kind);
        assert.equal(error.status, status);
        assert.doesNotMatch(error.message, /expired/i);
        return true;
    });
};

// ---- options and patient ----

test("options list ABDM's purposes, the eight HI types and access modes, with the defaults", async () => {
    const options = await service.options(ctx);
    assert.equal(options.configured, true);
    assert.equal(options.reason, undefined);
    assert.deepEqual(options.purposes.map((p) => p.code), ["CAREMGT", "BTG", "PUBHLTH", "HPAYMT", "DSRCH", "PATRQT"]);
    assert.equal(options.hiTypes.length, 8);
    assert.deepEqual(options.accessModes, ["VIEW", "STORE", "STREAM", "QUERY"]);
    assert.deepEqual(options.defaults, { purpose: "CAREMGT", accessMode: "VIEW" });
    settings.configured = false;
    assert.equal((await service.options(ctx)).configured, false);
});

test("patientAbha returns the stored address and a masked number, only for this hospital's patients", async () => {
    assert.deepEqual(await service.patientAbha(ctx, PATIENT), {
        userId: PATIENT, name: "Asha Kumari", abhaAddress: "asha.kumari@sbx", abhaNumberMasked: "xx-xxxx-xxxx-3333",
    });
    await assertRefused(service.patientAbha(otherHospital, PATIENT), "not-found", 404);
    await assertRefused(service.patientAbha(ctx, "not-a-guid"), "not-found", 404);
    assert.equal((await service.patientAbha(ctx, OTHER_PATIENT)).abhaAddress, null);
});

// ---- create ----

test("create stores the row as SENDING with its REQUEST-ID before init, which carries no X-HIU-ID", async () => {
    const summary = await service.create(ctx, input({ abhaAddress: "someone.else@sbx" } as any));
    assert.equal(calls.length, 1);
    const { call, seen } = calls[0]!;
    assert.equal(call.path, "/api/hiecm/consent/v3/request/init");
    assert.equal(call.method, "POST");
    assert.equal(call.headers?.["X-HIU-ID"], undefined);
    assert.equal(seen.request?.status, "SENDING", "the row existed, SENDING, when the call went out");
    assert.equal(seen.request?.initRequestId, call.requestId);

    const consent = (call.body as any).consent;
    assert.equal(consent.patient.id, "asha.kumari@sbx", "the address comes from the patient record, never the browser");
    assert.deepEqual(consent.purpose, { text: "Care Management", code: "CAREMGT", refUri: "http://terminology.hl7.org/ValueSet/v3-PurposeOfUse" });
    assert.equal(consent.hiu.id, HIU_ID);
    assert.equal(consent.requester.name, "Dr Rao");
    assert.deepEqual(consent.requester.identifier, { value: HIU_ID, type: "HFR", system: "https://facility.abdm.gov.in" });
    assert.deepEqual(consent.hiTypes, ["Prescription", "OPConsultation"]);
    // Whole IST days: from the start of 1 Jan, to now (less a margin) because the end of today is still ahead.
    assert.deepEqual(consent.permission.dateRange, { from: "2025-12-31T18:30:00.000Z", to: "2026-10-26T05:59:55.000Z" });
    assert.equal(consent.permission.dataEraseAt, "2026-12-31T18:29:00.000Z");
    assert.deepEqual(consent.permission.frequency, { unit: "HOUR", value: 1, repeats: 0 });
    for (const value of [consent.permission.dateRange.from, consent.permission.dateRange.to, consent.permission.dataEraseAt]) {
        assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }

    assert.equal(summary.status, "SENDING");
    assert.equal(summary.dateFrom, "2026-01-01");
    assert.equal(summary.dateTo, "2026-10-26");
    assert.deepEqual(summary.patient, { userId: PATIENT, name: "Asha Kumari", abhaAddress: "asha.kumari@sbx", abhaNumberMasked: "xx-xxxx-xxxx-3333" });
    assert.equal(summary.initRequestId, calls[0]!.call.requestId);
    assert.equal(summary.staffName, "Dr Rao");
    assert.equal(summary.abdmError, null);
    assert.ok(audits.some((event) => event.event === "CONSENT_INIT" && event.outcome === "OK" && event.requestId === call.requestId));
});

test("a past dateTo covers that whole IST day", async () => {
    await service.create(ctx, input({ dateFrom: "2026-10-01", dateTo: "2026-10-10" }));
    assert.deepEqual((calls[0]!.call.body as any).consent.permission.dateRange, { from: "2026-09-30T18:30:00.000Z", to: "2026-10-10T18:29:59.999Z" });
});

test("create refuses while the HIU is not configured, before storing or calling anything", async () => {
    settings.configured = false;
    await assertRefused(service.create(ctx, input()), "not-configured", 503);
    assert.equal(calls.length, 0);
    assert.equal(requests.length, 0);
});

test("every validation refusal stores nothing and calls nothing", async () => {
    const cases: [Partial<NewConsentRequestInput> & Record<string, unknown>, string][] = [
        [{ patientUserId: "x" }, "patientUserId"],
        [{ purposeCode: "TREATMENT" }, "purposeCode"],
        [{ purposeCode: undefined }, "purposeCode"],
        [{ hiTypes: [] }, "hiTypes"],
        [{ hiTypes: ["Prescription", "Prescription"] }, "hiTypes"],
        [{ hiTypes: ["LabReport"] }, "hiTypes"],
        [{ hiTypes: "Prescription" as never }, "hiTypes"],
        [{ dateFrom: "2026/01/01" }, "dateFrom"],
        [{ dateFrom: "2026-02-30" }, "dateFrom"],
        [{ dateTo: "" }, "dateTo"],
        [{ dateFrom: "2026-10-20", dateTo: "2026-10-10" }, "dateFrom"],
        [{ dateFrom: "2026-10-27", dateTo: "2026-10-27" }, "dateFrom"],
        [{ dateTo: "2026-10-28" }, "dateTo"],
        [{ dataEraseAt: "soon" }, "dataEraseAt"],
        [{ dataEraseAt: "2026-10-26T05:00:00Z" }, "dataEraseAt"],
        [{ accessMode: "EDIT" }, "accessMode"],
        [{ patientUserId: OTHER_PATIENT }, "patientUserId"],
    ];
    for (const [overrides, field] of cases) {
        await assert.rejects(service.create(ctx, input(overrides)), (error: any) => {
            assert.ok(error instanceof HiuError, `${field}: ${error?.message}`);
            assert.equal(error.kind, "validation", JSON.stringify(overrides));
            assert.equal(error.details?.field, field, JSON.stringify(overrides));
            assert.doesNotMatch(error.message, /expired/i);
            return true;
        });
    }
    // Not this hospital's patient; an ABHA address of the wrong environment.
    await assertRefused(service.create(otherHospital, input()), "not-found", 404);
    patients.get(PATIENT)!.abhaAddress = "asha.kumari@abdm";
    await assertRefused(service.create(ctx, input()), "validation", 400);
    patients.get(PATIENT)!.abhaAddress = "asha.kumari@sbx";

    assert.equal(calls.length, 0);
    assert.equal(requests.length, 0);
});

test("an open request for the same patient, purpose and an overlapping type is a 409; others may go", async () => {
    await raised();
    await assertRefused(service.create(ctx, input({ hiTypes: ["OPConsultation", "Invoice"] })), "conflict", 409);
    assert.equal(calls.length, 1);
    await service.create(ctx, input({ hiTypes: ["Invoice"] }));
    await service.create(ctx, input({ purposeCode: "PATRQT" }));
    assert.equal(calls.length, 3);
    // A SENDING request whose on-init never came stops blocking after a while.
    await assertRefused(service.create(ctx, input({ hiTypes: ["Invoice", "WellnessRecord"] })), "conflict", 409);
    now += 16 * 60_000;
    await service.create(ctx, input({ hiTypes: ["Invoice", "WellnessRecord"] }));
    assert.equal(calls.length, 4);
});

test("an ABDM refusal marks the request FAILED with ABDM's code and message and is rethrown", async () => {
    gatewayFault = () => new AbdmApiError({ status: 400, kind: "rejected", operation: "consent/v3/request/init", code: "ABDM-9999", message: "Invalid consent purpose refURI" });
    await assert.rejects(service.create(ctx, input()), AbdmApiError);
    assert.equal(requests[0]!.status, "FAILED");
    assert.equal(requests[0]!.abdmErrorCode, "ABDM-9999");
    assert.equal(requests[0]!.abdmError, "Invalid consent purpose refURI");
    assert.ok(audits.some((event) => event.event === "CONSENT_INIT" && event.outcome === "REJECTED"));
    const [summary] = (await service.list(ctx, { page: 1, pageSize: 20 })).items;
    assert.deepEqual(summary!.abdmError, { code: "ABDM-9999", message: "Invalid consent purpose refURI", requestId: requests[0]!.initRequestId });
    assert.equal(summary!.initRequestId, requests[0]!.initRequestId);
});

test("summaries show the patient's ABHA number masked to its last 4 digits, never whole, and null without one", async () => {
    await service.create(ctx, input());
    requests.push({ ...requests[0]!, id: 2, initRequestId: "init-2", patientUserId: OTHER_PATIENT, abhaAddress: "x@sbx" });
    const { items } = await service.list(ctx, { page: 1, pageSize: 20 });
    const byPatient = new Map(items.map((item) => [item.patient.userId, item.patient.abhaNumberMasked]));
    assert.equal(byPatient.get(PATIENT), "xx-xxxx-xxxx-3333");
    assert.equal(byPatient.get(OTHER_PATIENT), null);
    assert.ok(!JSON.stringify(items).includes("1111-2222"), "the whole number never leaves");
    assert.equal((await service.detail(ctx, 1)).patient.abhaNumberMasked, "xx-xxxx-xxxx-3333");
});

test("a request failed by on-init or by the sweep carries its init REQUEST-ID in abdmError, to quote to NHA", async () => {
    const first = await service.create(ctx, input());
    const row = requests.find((r) => r.id === first.id)!;
    await service.onInit({ error: { code: "ABDM-1040", message: "Patient not found" }, response: { requestId: row.initRequestId } }, headers("cb-err"));
    assert.deepEqual((await service.detail(ctx, first.id)).abdmError, { code: "ABDM-1040", message: "Patient not found", requestId: row.initRequestId });

    gatewayFault = () => initTimeout();
    const second = await service.create(ctx, input({ purposeCode: "PATRQT" })).catch((error) => error);
    assert.ok(second instanceof ConsentInitUnansweredError);
    now += 16 * 60_000;
    await service.failStaleSending();
    const stale = requests.find((r) => r.id === second.id)!;
    assert.equal(stale.status, "FAILED");
    assert.equal((await service.detail(ctx, stale.id)).abdmError!.requestId, stale.initRequestId);
});

test("two raises of the same need at once send the patient one request; the other is a 409", async () => {
    const results = await Promise.allSettled([service.create(ctx, input()), service.create(ctx, input())]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.ok(refused.reason instanceof HiuError && refused.reason.kind === "conflict");
    assert.equal(requests.length, 1);
    assert.deepEqual(pathsCalled(), ["request/init"]);
});

const initTimeout = () => new AbdmApiError({ status: 0, kind: "timeout", operation: "consent/v3/request/init", message: "ABDM did not reply within 30 seconds." });

test("an init whose answer timed out after on-init came keeps REQUESTED, so the request stays open", async () => {
    // ABDM took the init and its on-init arrived before our wait for the 202 ran out.
    gatewayFault = async (call) => {
        await service.onInit({ consentRequest: { id: CONSENT_REQUEST }, error: null, response: { requestId: call.requestId } }, headers("cb-early"));
        return initTimeout();
    };
    await assert.rejects(service.create(ctx, input()), AbdmApiError);
    assert.equal(requests[0]!.status, "REQUESTED");
    assert.equal(requests[0]!.consentRequestId, CONSENT_REQUEST);
    assert.equal(requests[0]!.abdmError, null);
    // It still blocks a duplicate request for the same need.
    gatewayFault = null;
    await assertRefused(service.create(ctx, input()), "conflict", 409);
});

test("an init with no answer stays SENDING for its on-init; only a refusal marks it FAILED", async () => {
    gatewayFault = () => initTimeout();
    const unanswered = await service.create(ctx, input()).catch((error) => error);
    const row = requests[0]!;
    // Still an AbdmApiError of the same kind (504 stays 504), naming the stored row so the list can be reloaded.
    assert.ok(unanswered instanceof ConsentInitUnansweredError && unanswered instanceof AbdmApiError);
    assert.equal(unanswered.kind, "timeout");
    assert.equal(unanswered.id, row.id);
    assert.equal(unanswered.initRequestId, row.initRequestId);
    assert.equal(unanswered.requestId, row.initRequestId);
    assert.equal(row.status, "SENDING");
    assert.equal(row.abdmError, "ABDM did not reply within 30 seconds.");
    assert.ok(audits.some((event) => event.event === "CONSENT_INIT" && event.outcome === "FAILED"));

    gatewayFault = null;
    await service.onInit({ consentRequest: { id: CONSENT_REQUEST }, error: null, response: { requestId: row.initRequestId } }, headers("cb-late"));
    assert.equal(row.status, "REQUESTED");
    assert.equal(row.abdmError, null);
});

test("a request whose on-init never came is failed by the sweep after 15 minutes; a late on-init still recovers it", async () => {
    await service.create(ctx, input());
    const row = requests[0]!;
    now += 14 * 60_000;
    assert.equal(await service.failStaleSending(), 0);
    assert.equal(row.status, "SENDING");

    now += 2 * 60_000;
    assert.equal(await service.failStaleSending(), 1);
    assert.equal(row.status, "FAILED");
    assert.match(row.abdmError!, /did not confirm/);
    assert.doesNotMatch(row.abdmError!, /expired/i);
    assert.ok(audits.some((event) => event.event === "CONSENT_INIT" && event.outcome === "FAILED" && event.detail === "no on-init" && event.requestId === row.initRequestId));
    assert.equal(await service.failStaleSending(), 0, "a FAILED request is not failed again");

    await service.onInit({ consentRequest: { id: CONSENT_REQUEST }, error: null, response: { requestId: row.initRequestId } }, headers("cb-late"));
    assert.equal(row.status, "REQUESTED");
});

// ---- on-init, status, on-status ----

test("on-init stores ABDM's consent request id and REQUESTED; an error marks FAILED; unknown ids are dropped", async () => {
    const row = await raised();
    assert.equal(row.status, "REQUESTED");
    assert.equal(row.consentRequestId, CONSENT_REQUEST);

    await service.create(ctx, input({ purposeCode: "BTG" }));
    const second = requests[1]!;
    await service.onInit({ consentRequest: null, error: { code: "ABDM-1040: ", message: "Invalid HIU ID" }, response: { requestId: second.initRequestId } }, headers("cb-2"));
    assert.equal(second.status, "FAILED");
    assert.equal(second.abdmErrorCode, "ABDM-1040");

    const before = JSON.stringify(requests);
    await service.onInit({ consentRequest: { id: "dddddddd-0000-4000-8000-00000000000d" }, error: null, response: { requestId: "never-sent" } }, headers("cb-3"));
    await service.onInit({}, headers(null));
    assert.equal(JSON.stringify(requests), before);
    assert.ok(audits.some((event) => event.event === "ON_INIT" && event.outcome === "IGNORED"));
});

test("refresh-status sends request/status with X-HIU-ID and its REQUEST-ID stored first; on-status updates it", async () => {
    const row = await raised();
    await service.refreshStatus(ctx, row.id);
    const { call, seen } = calls[1]!;
    assert.equal(call.path, "/api/hiecm/consent/v3/request/status");
    assert.equal(call.headers?.["X-HIU-ID"], HIU_ID);
    assert.deepEqual(call.body, { consentRequestId: CONSENT_REQUEST });
    assert.equal(seen.request?.statusRequestId, call.requestId);

    // GRANTED is accepted although the spec's on-status enum leaves it out.
    await service.onStatus({ consentRequest: { id: CONSENT_REQUEST, status: "GRANTED" }, error: null, response: { requestId: call.requestId }, resp: null }, headers("cb-s"));
    assert.equal(row.status, "GRANTED");
    // Unknown REQUEST-IDs change nothing.
    await service.onStatus({ consentRequest: { id: CONSENT_REQUEST, status: "DENIED" }, response: { requestId: "nope" } }, headers("cb-s2"));
    assert.equal(row.status, "GRANTED");

    await assertRefused(service.refreshStatus(otherHospital, row.id), "not-found", 404);
});

test("refresh-status is refused (no call) before ABDM has given the request an id", async () => {
    const summary = await service.create(ctx, input());
    await assertRefused(service.refreshStatus(ctx, summary.id), "conflict", 409);
    assert.deepEqual(pathsCalled(), ["request/init"]);
});

// ---- notify ----

test("GRANTED stores every artefact id, acknowledges one per artefact, then fetches each with X-HIU-ID", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B], "notify-req-1");
    assert.equal(row.status, "GRANTED");
    assert.deepEqual(artefacts.map((artefact) => artefact.consentArtefactId), [ARTEFACT_A, ARTEFACT_B]);
    assert.deepEqual(pathsCalled(), ["request/init", "request/hiu/on-notify", "fetch", "fetch"]);

    const ack = calls[1]!.call;
    assert.equal(ack.headers?.["X-HIU-ID"], undefined);
    assert.deepEqual(ack.body, {
        acknowledgement: [{ status: "OK", consentId: ARTEFACT_A }, { status: "OK", consentId: ARTEFACT_B }],
        response: { requestId: "notify-req-1" },
    });
    for (const [index, consentId] of [ARTEFACT_A, ARTEFACT_B].entries()) {
        const { call, seen } = calls[2 + index]!;
        assert.equal(call.headers?.["X-HIU-ID"], HIU_ID);
        assert.deepEqual(call.body, { consentId });
        assert.equal(seen.artefact?.consentArtefactId, consentId, "FetchRequestId stored before the call");
    }
    assert.ok(audits.some((event) => event.event === "NOTIFY_GRANTED"));
    assert.equal(audits.filter((event) => event.event === "FETCH" && event.outcome === "OK").length, 2);
});

test("a repeated GRANTED notify adds nothing and fetches nothing again", async () => {
    await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B], "notify-1");
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B], "notify-1");
    assert.equal(artefacts.length, 2);
    assert.equal(pathsCalled().filter((path) => path === "fetch").length, 2);
    // ABDM is acknowledged again: it may be retrying because our first answer never reached it.
    assert.equal(pathsCalled().filter((path) => path === "request/hiu/on-notify").length, 2);
});

const fetchesOf = (consentId: string) => calls.filter(({ call }) => call.path.endsWith("/fetch") && (call.body as any).consentId === consentId);
const fetchFault = (consentId: string, error: () => AbdmApiError) => (call: AbdmCall) =>
    (call.path.endsWith("/fetch") && (call.body as any).consentId === consentId ? error() : null);
const fetchTimeout = () => new AbdmApiError({ status: 0, kind: "timeout", operation: "consent/v3/fetch", message: "no reply" });
const fetchRefused = () => new AbdmApiError({ status: 500, kind: "unavailable", operation: "consent/v3/fetch", message: "Internal error" });

test("a fetch with no answer keeps its claim: the late on-fetch still matches and the records are requested", async () => {
    await raised();
    gatewayFault = fetchFault(ARTEFACT_B, fetchTimeout);
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    const requestId = fetchesOf(ARTEFACT_B)[0]!.call.requestId!;
    assert.equal(artefacts[1]!.fetchRequestId, requestId, "not released: ABDM may have taken it");
    assert.ok(audits.some((event) => event.event === "FETCH" && event.outcome === "FAILED" && event.artefactId === ARTEFACT_B));

    gatewayFault = null;
    await service.onFetch(onFetchBody(requestId, ARTEFACT_B), headers("late-fetch"));
    assert.ok(artefacts[1]!.fetchedAt);
    assert.deepEqual(requested, [artefacts[1]!.id]);
});

test("a refused fetch is released and the sweep fetches it again with a fresh REQUEST-ID, a few times at most", async () => {
    await raised();
    gatewayFault = fetchFault(ARTEFACT_B, fetchRefused);
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    assert.equal(artefacts[1]!.fetchRequestId, null);
    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_A), ARTEFACT_A), headers("f-a"));
    // The notification is acknowledged, so ABDM never repeats it: only the sweep can try again, and not at once.
    assert.equal(await service.retryFetches(), 0);

    gatewayFault = null;
    now += 5 * 60_000;
    assert.equal(await service.retryFetches(), 1);
    const retry = fetchesOf(ARTEFACT_B)[1]!;
    assert.equal(retry.call.headers?.["X-HIU-ID"], HIU_ID);
    assert.equal(retry.seen.artefact?.consentArtefactId, ARTEFACT_B, "the new REQUEST-ID was stored before the call");
    assert.notEqual(retry.call.requestId, fetchesOf(ARTEFACT_B)[0]!.call.requestId);
    assert.equal(fetchesOf(ARTEFACT_A).length, 1, "a fetched artefact is not fetched again");

    await service.onFetch(onFetchBody(retry.call.requestId!, ARTEFACT_B), headers("f-b"));
    assert.ok(artefacts[1]!.fetchedAt);
    now += 60 * 60_000;
    assert.equal(await service.retryFetches(), 0);
    assert.equal(fetchesOf(ARTEFACT_B).length, 2);
});

test("an artefact ABDM keeps refusing is fetched at most four times in all", async () => {
    await raised();
    gatewayFault = fetchFault(ARTEFACT_A, fetchRefused);
    await notify("GRANTED", [ARTEFACT_A]);
    for (let sweep = 0; sweep < 8; sweep += 1) {
        now += 5 * 60_000;
        await service.retryFetches();
    }
    assert.equal(fetchesOf(ARTEFACT_A).length, 4);
    assert.equal(artefacts[0]!.fetchedAt, null);
});

test("a fetch whose on-fetch never comes is fetched again under a new REQUEST-ID; the old id's late answer is dropped", async () => {
    await raised();
    gatewayFault = fetchFault(ARTEFACT_A, fetchTimeout);
    await notify("GRANTED", [ARTEFACT_A]);
    const first = fetchesOf(ARTEFACT_A)[0]!.call.requestId!;
    gatewayFault = null;
    now += 5 * 60_000;
    assert.equal(await service.retryFetches(), 1);
    const second = fetchesOf(ARTEFACT_A)[1]!.call.requestId!;
    assert.equal(artefacts[0]!.fetchRequestId, second);

    await service.onFetch(onFetchBody(first, ARTEFACT_A), headers("old"));
    assert.equal(artefacts[0]!.fetchedAt, null);
    await service.onFetch(onFetchBody(second, ARTEFACT_A), headers("new"));
    assert.deepEqual(requested, [artefacts[0]!.id]);
});

test("the sweep fetches nothing while the HIU is not configured, or for an artefact no longer granted", async () => {
    await raised();
    gatewayFault = fetchFault(ARTEFACT_A, fetchRefused);
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    gatewayFault = fetchFault(ARTEFACT_B, fetchRefused);
    now += 5 * 60_000;
    settings.configured = false;
    assert.equal(await service.retryFetches(), 0);
    settings.configured = true;
    await notify("REVOKED", [ARTEFACT_A, ARTEFACT_B], "revoke");
    const before = calls.length;
    assert.equal(await service.retryFetches(), 0);
    assert.equal(calls.length, before);
});

for (const status of ["DENIED", "EXPIRED"]) {
    test(`${status} ends the request with an empty acknowledgement, and never fetches`, async () => {
        const row = await raised();
        await notify(status, [], `notify-${status}`);
        assert.equal(row.status, status);
        assert.deepEqual(pathsCalled(), ["request/init", "request/hiu/on-notify"]);
        assert.deepEqual(calls[1]!.call.body, { acknowledgement: [], response: { requestId: `notify-${status}` } });

        // Repeats, and a later status call, change nothing and fetch nothing.
        const statusAt = row.statusAt;
        now += 60_000;
        await notify(status, [], `notify-${status}-again`);
        await service.onStatus({ consentRequest: { id: CONSENT_REQUEST, status: "REQUESTED" }, response: { requestId: "x" } }, headers("y"));
        assert.equal(row.status, status);
        assert.equal(row.statusAt, statusAt, "the time of the decision is kept");
        assert.equal(pathsCalled().filter((path) => path === "fetch").length, 0);
        assert.equal(artefacts.length, 0);
    });
}

test("a notification for a consent request we do not hold is dropped, unacknowledged", async () => {
    await raised();
    await notify("GRANTED", [ARTEFACT_A], "foreign", "eeeeeeee-0000-4000-8000-00000000000e");
    assert.equal(artefacts.length, 0);
    assert.deepEqual(pathsCalled(), ["request/init"]);
    assert.ok(audits.some((event) => event.event === "NOTIFY_GRANTED" && event.outcome === "IGNORED" && event.hospitalId === null));
});

test("REVOKED blocks the named artefact and deletes its records; the request becomes PARTLY_REVOKED, then REVOKED", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    const [a, b] = artefacts;
    records.push({ artefactFk: a!.id }, { artefactFk: a!.id }, { artefactFk: b!.id });
    privateKeys.set(a!.id, "sealed-key");
    const fetchesBefore = pathsCalled().filter((path) => path === "fetch").length;

    // A revocation names only the artefacts (the spec's REVOKED carries consentArtefacts).
    await notify("REVOKED", [ARTEFACT_A], "revoke-1", null);
    assert.equal(a!.status, "REVOKED");
    assert.ok(a!.recordsPurgedAt);
    assert.equal(privateKeys.get(a!.id), null);
    assert.deepEqual(records, [{ artefactFk: b!.id }]);
    assert.equal(row.status, "PARTLY_REVOKED");
    assert.deepEqual(calls.at(-1)!.call.body, { acknowledgement: [{ status: "OK", consentId: ARTEFACT_A }], response: { requestId: "revoke-1" } });

    // Repeated: nothing more happens.
    await notify("REVOKED", [ARTEFACT_A], "revoke-1", null);
    assert.equal(audits.filter((event) => event.event === "RECORD_PURGED").length, 1);

    await notify("REVOKED", [ARTEFACT_B], "revoke-2");
    assert.equal(b!.status, "REVOKED");
    assert.equal(records.length, 0);
    assert.equal(row.status, "REVOKED");
    assert.equal(pathsCalled().filter((path) => path === "fetch").length, fetchesBefore, "a revocation never fetches");

    const detail = await service.detail(ctx, row.id);
    assert.deepEqual(detail.artefacts.map((artefact) => artefact.stage), ["BLOCKED", "BLOCKED"]);
    // A GRANTED arriving late (out of order) does not bring a revoked artefact back.
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B], "late-grant");
    assert.equal(row.status, "REVOKED");
    assert.equal(pathsCalled().filter((path) => path === "fetch").length, fetchesBefore);
});

test("a REVOKED or EXPIRED notify naming artefacts never stored keeps their ids, already ended, and fetches nothing", async () => {
    const row = await raised();
    // The GRANTED notify was lost: no artefact is stored yet.
    await notify("REVOKED", [ARTEFACT_A], "revoke-unknown");
    assert.deepEqual(artefacts.map((artefact) => [artefact.consentArtefactId, artefact.status, Boolean(artefact.recordsPurgedAt)]), [[ARTEFACT_A, "REVOKED", true]]);
    assert.equal(row.status, "REVOKED");
    assert.deepEqual(calls.at(-1)!.call.body, { acknowledgement: [{ status: "OK", consentId: ARTEFACT_A }], response: { requestId: "revoke-unknown" } });

    await notify("EXPIRED", [ARTEFACT_B], "expire-unknown");
    assert.deepEqual(artefacts.map((artefact) => artefact.status), ["REVOKED", "EXPIRED"]);
    // A late GRANTED for the same ids does not bring them back, and nothing is fetched.
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B], "late-grant");
    assert.equal(pathsCalled().filter((path) => path === "fetch").length, 0);
    now += 60 * 60_000;
    assert.equal(await service.retryFetches(), 0);
});

test("EXPIRED of a granted consent with no artefacts named ends every artefact", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    records.push({ artefactFk: artefacts[0]!.id });
    await notify("EXPIRED", []);
    assert.deepEqual(artefacts.map((artefact) => artefact.status), ["EXPIRED", "EXPIRED"]);
    assert.equal(records.length, 0);
    assert.equal(row.status, "EXPIRED");
});

// ---- on-fetch ----

const fetchRequestIdOf = (consentArtefactId: string) => artefacts.find((artefact) => artefact.consentArtefactId === consentArtefactId)!.fetchRequestId!;

test("on-fetch stores what was granted (care contexts sealed) and asks for the records once", async () => {
    await raised();
    await notify("GRANTED", [ARTEFACT_A]);
    const requestId = fetchRequestIdOf(ARTEFACT_A);
    await service.onFetch(onFetchBody(requestId, ARTEFACT_A), headers("cb-f"));
    const artefact = artefacts[0]!;
    assert.deepEqual(requested, [artefact.id]);
    assert.equal(artefact.hipId, "HIP-1");
    assert.deepEqual(artefact.hiTypes, ["Prescription"]);
    assert.equal(artefact.dataEraseAt?.toISOString(), "2026-11-30T00:00:00.000Z");
    const sealed = savedCareContexts.get(artefact.id)!;
    assert.doesNotMatch(sealed, /CC-SECRET-1/);
    assert.deepEqual(JSON.parse(open(sealed, keys).toString("utf8")), [{ patientReference: "PR-1", careContextReference: "CC-SECRET-1" }]);

    await service.onFetch(onFetchBody(requestId, ARTEFACT_A), headers("cb-f2"));
    assert.deepEqual(requested, [artefact.id], "a repeated on-fetch asks for nothing more");

    const detail = await service.detail(ctx, artefact.consentRequestFk);
    assert.deepEqual(detail.artefacts[0]!.granted, {
        hiTypes: ["Prescription"], dateFrom: "2026-03-01T00:00:00.000Z", dateTo: "2026-09-30T00:00:00.000Z",
        dataEraseAt: "2026-11-30T00:00:00.000Z", accessMode: "VIEW",
    });
    assert.equal(detail.artefacts[0]!.stage, "REQUESTING_RECORDS");
    assert.deepEqual(detail.artefacts[0]!.hip, { id: "HIP-1", name: "City Lab" });
    assert.ok(detail.events.some((event) => event.event === "ON_FETCH" && event.outcome === "GRANTED"));
    assert.ok(detail.events.some((event) => event.event === "CONSENT_INIT"));
    assert.ok(!JSON.stringify(detail.events).includes("CC-SECRET"));
});

test("on-fetch reads dataEraseAt inside permission too, and asks for nothing once it has passed", async () => {
    await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_A), ARTEFACT_A, {
        dataEraseAt: undefined,
        permission: { accessMode: "VIEW", dateRange: { from: "2026-03-01T00:00:00.000Z", to: "2026-09-30T00:00:00.000Z" }, dataEraseAt: "2026-12-01T00:00:00.000Z" },
    }), headers("f1"));
    assert.equal(artefacts[0]!.dataEraseAt?.toISOString(), "2026-12-01T00:00:00.000Z");
    assert.deepEqual(requested, [artefacts[0]!.id]);

    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_B), ARTEFACT_B, { dataEraseAt: "2026-10-26T05:00:00.000Z" }), headers("f2"));
    assert.deepEqual(requested, [artefacts[0]!.id], "past dataEraseAt: no request");
});

test("on-fetch that is not GRANTED blocks the artefact and asks for nothing", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    await service.onFetch({ ...onFetchBody(fetchRequestIdOf(ARTEFACT_A), ARTEFACT_A), consent: { status: "REVOKED", consentDetail: null, signature: "" } }, headers("f"));
    assert.equal(artefacts[0]!.status, "REVOKED");
    assert.equal(row.status, "PARTLY_REVOKED");
    assert.deepEqual(requested, []);
});

test("an on-fetch arriving after a revocation stores nothing on the revoked artefact and asks for nothing", async () => {
    await raised();
    await notify("GRANTED", [ARTEFACT_A]);
    const requestId = fetchRequestIdOf(ARTEFACT_A);
    await notify("REVOKED", [ARTEFACT_A], "revoke-first", null);
    // ABDM's answer to the fetch, sent before the revocation, still says GRANTED.
    await service.onFetch(onFetchBody(requestId, ARTEFACT_A), headers("late"));
    const artefact = artefacts[0]!;
    assert.equal(artefact.status, "REVOKED");
    assert.equal(artefact.fetchedAt, null);
    assert.equal(artefact.hipId, null);
    assert.equal(savedCareContexts.has(artefact.id), false, "no sealed care contexts written back");
    assert.deepEqual(requested, []);
});

test("on-fetch survives a failing requester, and drops unknown or mismatched answers", async () => {
    await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    requesterFault = true;
    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_A), ARTEFACT_A), headers("f"));
    assert.equal(requested.length, 1);

    await service.onFetch(onFetchBody("never-sent", ARTEFACT_B), headers("f2"));
    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_B), ARTEFACT_A), headers("f3"));
    assert.equal(artefacts[1]!.fetchedAt, null);
    assert.equal(requested.length, 1);
    assert.ok(audits.some((event) => event.event === "ON_FETCH" && event.outcome === "IGNORED"));
});

test("callback handlers never throw, even when the store fails", async () => {
    const broken = new HiuConsentService({
        ...store,
        findRequestByInitRequestId: async () => { throw new Error("db down"); },
        findRequestByConsentRequestId: async () => { throw new Error("db down"); },
        findArtefactByFetchRequestId: async () => { throw new Error("db down"); },
        findRequestByStatusRequestId: async () => { throw new Error("db down"); },
    }, { gateway, audit: { record: async () => {} }, clock: () => now, settings: () => settings, directory, pushBaseUrl: async () => pushBase });
    await broken.onInit({ response: { requestId: "x" } }, headers("a"));
    await broken.onStatus({ response: { requestId: "x" } }, headers("a"));
    await broken.notify({ notification: { consentRequestId: CONSENT_REQUEST, status: "GRANTED", consentArtefacts: [] } }, headers("a"));
    await broken.onFetch({ response: { requestId: "x" } }, headers("a"));
    assert.equal(calls.length, 0);
});

// ---- list, detail, stages ----

test("list and detail are scoped to the staff member's hospital", async () => {
    const row = await raised();
    const listed = await service.list(ctx, { page: 1, pageSize: 20 });
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0]!.consentRequestId, CONSENT_REQUEST);
    assert.equal((await service.list(otherHospital, { page: 1, pageSize: 20 })).total, 0);
    assert.equal((await service.list(ctx, { page: 1, pageSize: 20, status: "DENIED" })).total, 0);
    await assertRefused(service.list(ctx, { page: 1, pageSize: 20, status: "LOST" }), "validation", 400);
    await assertRefused(service.detail(otherHospital, row.id), "not-found", 404);
    await assertRefused(service.detail(ctx, 999), "not-found", 404);
});

test("artefact stage follows the artefact and its latest transfer", () => {
    const base = { status: "GRANTED" as const, recordsPurgedAt: null, fetchedAt: new Date(now), dataEraseAt: new Date(now + 86_400_000), transfer: null };
    const transfer = (sessionStatus: string, transactionId: string | null = "txn") =>
        ({ transactionId, sessionStatus, pageCount: null, pagesReceived: 0, error: null, requestedAt: new Date(now), completedAt: null });
    assert.equal(artefactStage({ ...base, fetchedAt: null }, now), "FETCHING_DETAILS");
    assert.equal(artefactStage(base, now), "REQUESTING_RECORDS");
    assert.equal(artefactStage({ ...base, transfer: transfer("REQUESTED", null) }, now), "REQUESTING_RECORDS");
    assert.equal(artefactStage({ ...base, transfer: transfer("REQUESTED") }, now), "WAITING_FOR_PROVIDER");
    assert.equal(artefactStage({ ...base, transfer: transfer("RECEIVING") }, now), "RECEIVING");
    assert.equal(artefactStage({ ...base, transfer: transfer("RECEIVED") }, now), "RECEIVED");
    assert.equal(artefactStage({ ...base, transfer: transfer("FAILED") }, now), "TRANSFER_FAILED");
    assert.equal(artefactStage({ ...base, recordsPurgedAt: new Date(now), transfer: transfer("RECEIVED") }, now), "RECORDS_DELETED");
    assert.equal(artefactStage({ ...base, dataEraseAt: new Date(now - 1) }, now), "RECORDS_DELETED");
    for (const status of ["REVOKED", "EXPIRED", "DENIED"] as const) {
        assert.equal(artefactStage({ ...base, status, recordsPurgedAt: new Date(now) }, now), "BLOCKED");
    }
});

test("a request's status follows its artefacts", () => {
    assert.equal(requestStatusFrom([]), null);
    assert.equal(requestStatusFrom([{ status: "GRANTED" }, { status: "GRANTED" }]), "GRANTED");
    assert.equal(requestStatusFrom([{ status: "GRANTED" }, { status: "REVOKED" }]), "PARTLY_REVOKED");
    assert.equal(requestStatusFrom([{ status: "REVOKED" }, { status: "EXPIRED" }]), "REVOKED");
    assert.equal(requestStatusFrom([{ status: "EXPIRED" }]), "EXPIRED");
    assert.equal(requestStatusFrom([{ status: "DENIED" }]), "DENIED");
});

test("no log line carries the ABHA address or a care-context reference", async () => {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
        await raised();
        await notify("GRANTED", [ARTEFACT_A]);
        await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_A), ARTEFACT_A), headers("f"));
        await notify("REVOKED", [ARTEFACT_A]);
    } finally {
        Object.assign(console, original);
    }
    assert.ok(lines.length > 0);
    assert.ok(!lines.some((line) => /asha\.kumari|CC-SECRET|PR-1|sig==/.test(line)), lines.join("\n"));
});

// ---- per tenant: each hospital asks as its own HIU, and callbacks only reach requests raised as it ----

test("options say per hospital whether it can raise requests, and why not", async () => {
    hius.delete(20);
    const notSetUp = await service.options(otherHospital);
    assert.equal(notSetUp.configured, false);
    assert.match(notSetUp.reason!, /isn't set up as an ABDM HIU facility/);
    assert.doesNotMatch(notSetUp.reason!, /expired/i);
    assert.equal((await service.options(ctx)).configured, true, "another hospital's HIU does not make this one configured, nor the other way");

    pushBase = "";
    const noPush = await service.options(ctx);
    assert.equal(noPush.configured, false);
    assert.match(noPush.reason!, /push address/);
});

test("a hospital without an HIU id gets 503 not-configured: nothing stored, no call, never another hospital's id", async () => {
    hius.delete(20);
    patients.get(B_PATIENT)!.hospitalId = 20;
    await assert.rejects(service.create(otherHospital, input({ patientUserId: B_PATIENT })), (error: any) => {
        assert.ok(error instanceof HiuError);
        assert.equal(error.kind, "not-configured");
        assert.equal(error.status, 503);
        assert.match(error.message, /This hospital isn't set up as an ABDM HIU facility/);
        assert.doesNotMatch(error.message, /expired/i);
        return true;
    });
    assert.equal(calls.length, 0);
    assert.equal(requests.length, 0);
    // An entry for a hospital that answers with another hospital's HIU is refused too.
    hius.set(20, { id: HIU_ID, hospitalId: 19, name: "A A Hospital" });
    await assertRefused(service.create(otherHospital, input({ patientUserId: B_PATIENT })), "not-configured", 503);
    assert.equal(calls.length, 0);
});

test("an HIU id two hospitals would answer to (one's HIU id, the other's HIP id) is used by neither", async () => {
    // Rows written around save()'s check (two overlapping admin saves, a direct edit): the indexes
    // are per column, so nothing in the database stops it.
    const facilities = new AbdmFacilityDirectory({
        async list() {
            return [
                { hospitalId: 19, hipId: null, hiuId: HIU_ID, name: "A A Hospital", scanShareHipId: null, autoLink: false },
                { hospitalId: 20, hipId: HIU_ID, hiuId: null, name: "B B Clinic", scanShareHipId: null, autoLink: false },
            ];
        },
        async save() {},
    });
    const shared = new HiuConsentService(store, {
        gateway,
        audit: { record: async (event) => { audits.push(event); } },
        clock: () => now,
        settings: () => settings,
        directory: facilities,
        pushBaseUrl: async () => pushBase,
        atRestKeys: () => keys,
        newId: () => "req-shared",
    });
    for (const staff of [ctx, otherHospital]) {
        const options = await shared.options(staff);
        assert.equal(options.configured, false, `hospital ${staff.hospitalId}`);
        assert.match(options.reason!, /isn't set up as an ABDM HIU facility/);
    }
    await assertRefused(shared.create(ctx, input()), "not-configured", 503);
    await assertRefused(shared.create(otherHospital, input({ patientUserId: B_PATIENT })), "not-configured", 503);
    assert.equal(calls.length, 0);
    assert.equal(requests.length, 0);
});

/** Raises a request at hospital 20 (HIU_B) and lets on-init answer it as HIU_B. */
const raisedAtB = async (): Promise<ConsentRequestRow> => {
    const summary = await service.create(otherHospital, input({ patientUserId: B_PATIENT }));
    const row = requests.find((r) => r.id === summary.id)!;
    await service.onInit({ consentRequest: { id: B_CONSENT_REQUEST }, error: null, response: { requestId: row.initRequestId } }, { requestId: "cb-init-b", hiuId: HIU_B, timestamp: null });
    return row;
};

test("two hospitals raise requests each as its own HIU: consent.hiu, requester and the stored HIU id never cross", async () => {
    const a = await raised();
    const b = await raisedAtB();
    assert.equal(a.hiuId, HIU_ID);
    assert.equal(b.hiuId, HIU_B);
    const [initA, initB] = calls.filter(({ call }) => call.path.endsWith("/request/init")).map(({ call }) => (call.body as any).consent);
    assert.deepEqual(initA.hiu, { id: HIU_ID, name: "A A Hospital" });
    assert.deepEqual(initB.hiu, { id: HIU_B, name: "B B Clinic" });
    assert.equal(initB.requester.identifier.value, HIU_B);
    assert.equal(b.status, "REQUESTED");

    await service.refreshStatus(otherHospital, b.id);
    await service.refreshStatus(ctx, a.id);
    const statuses = calls.filter(({ call }) => call.path.endsWith("/request/status")).map(({ call }) => call.headers?.["X-HIU-ID"]);
    assert.deepEqual(statuses, [HIU_B, HIU_ID]);
});

test("a request keeps the HIU id it was raised as, even after its hospital's id changes", async () => {
    const a = await raised();
    hius.set(19, { id: "IN3610009999", hospitalId: 19, name: "A A Hospital" });
    await service.refreshStatus(ctx, a.id);
    assert.equal(calls.at(-1)!.call.headers?.["X-HIU-ID"], HIU_ID);
    assert.equal(requests.find((r) => r.id === a.id)!.hiuId, HIU_ID);
});

test("a callback whose X-HIU-ID names hospital A's facility cannot update hospital B's request", async () => {
    const b = await raisedAtB();
    const asA = (requestId: string) => ({ requestId, hiuId: HIU_ID, timestamp: null });
    const before = calls.length;

    // on-init for B's init REQUEST-ID, sent as A: dropped.
    const second = await service.create(otherHospital, input({ patientUserId: B_PATIENT, purposeCode: "PATRQT" }));
    const secondRow = requests.find((r) => r.id === second.id)!;
    await service.onInit({ consentRequest: { id: "dddddddd-0000-4000-8000-00000000000d" }, error: null, response: { requestId: secondRow.initRequestId } }, asA("x-init"));
    assert.equal(secondRow.status, "SENDING");
    assert.equal(secondRow.consentRequestId, null);
    assert.deepEqual([audits.at(-1)!.event, audits.at(-1)!.outcome, audits.at(-1)!.detail], ["ON_INIT", "IGNORED", "HIU mismatch"]);

    // on-status as A: dropped.
    await service.refreshStatus(otherHospital, b.id);
    const statusId = calls.at(-1)!.call.requestId!;
    await service.onStatus({ consentRequest: { id: B_CONSENT_REQUEST, status: "DENIED" }, response: { requestId: statusId } }, asA("x-status"));
    assert.equal(b.status, "REQUESTED");

    // notify GRANTED as A: nothing stored, acknowledged or fetched.
    const callsBeforeNotify = calls.length;
    await service.notify({ notification: { consentRequestId: B_CONSENT_REQUEST, status: "GRANTED", consentArtefacts: [{ id: B_ARTEFACT }] } }, asA("x-notify"));
    assert.equal(artefacts.length, 0);
    assert.equal(b.status, "REQUESTED");
    assert.equal(calls.length, callsBeforeNotify, "no on-notify, no fetch");
    assert.deepEqual([audits.at(-1)!.outcome, audits.at(-1)!.detail, audits.at(-1)!.hospitalId], ["IGNORED", "HIU mismatch", 20]);

    // As B it goes through, and the fetch is sent as B.
    await service.notify({ notification: { consentRequestId: B_CONSENT_REQUEST, status: "GRANTED", consentArtefacts: [{ id: B_ARTEFACT }] } }, { requestId: "b-notify", hiuId: HIU_B, timestamp: null });
    assert.equal(b.status, "GRANTED");
    const fetch = calls.at(-1)!.call;
    assert.equal(fetch.path, "/api/hiecm/consent/v3/fetch");
    assert.equal(fetch.headers?.["X-HIU-ID"], HIU_B);

    // on-fetch as A: nothing stored, no records asked for; as B: stored.
    await service.onFetch(onFetchBody(fetchRequestIdOf(B_ARTEFACT), B_ARTEFACT), asA("x-fetch"));
    assert.equal(artefacts[0]!.fetchedAt, null);
    assert.deepEqual(requested, []);
    await service.onFetch(onFetchBody(fetchRequestIdOf(B_ARTEFACT), B_ARTEFACT), { requestId: "b-fetch", hiuId: HIU_B, timestamp: null });
    assert.ok(artefacts[0]!.fetchedAt);
    assert.deepEqual(requested, [artefacts[0]!.id]);

    // A revocation as A, naming only B's artefact, ends nothing.
    await service.notify({ notification: { status: "REVOKED", consentArtefacts: [{ id: B_ARTEFACT }] } }, asA("x-revoke"));
    assert.equal(artefacts[0]!.status, "GRANTED");
    assert.ok(calls.length > before);
});

test("a request with no HIU id on record is never asked about or fetched as another HIU", async () => {
    const a = await raised();
    await notify("GRANTED", [ARTEFACT_A]);
    const row = requests.find((r) => r.id === a.id)!;
    row.hiuId = null;
    await assertRefused(service.refreshStatus(ctx, a.id), "conflict", 409);
    // Its fetch was refused; the sweep does not ask again without an HIU id.
    const artefact = artefacts.find((x) => x.consentArtefactId === ARTEFACT_A)!;
    artefact.fetchRequestId = null;
    now += 10 * 60_000;
    const before = calls.length;
    assert.equal(await service.retryFetches(), 0);
    assert.equal(calls.length, before);
    // And no callback can match it.
    await service.onStatus({ consentRequest: { id: CONSENT_REQUEST, status: "REVOKED" }, response: { requestId: "none" } }, headers("cb"));
    await notify("REVOKED", [ARTEFACT_A], "revoke-1");
    assert.equal(artefact.status, "GRANTED");
});
