import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import { AbdmFacilityDirectory } from "../abdm-facilities.service.js";
import { AbdmApiError, type AbdmCall } from "../abdm-gateway.service.js";
import { atRestKeysFrom, open } from "./hiu-at-rest.js";
import type { HiuAuditEventInput } from "./hiu-audit.js";
import { RecordPurgeError } from "./hiu-db-errors.js";
import { HiuError } from "./hiu-enums.js";
import {
    ConsentInitUnansweredError,
    HiuConsentService,
    artefactStage,
    deleteByOf,
    requestEnding,
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
/** A request's UpdatedAt, as the clock read when it was last changed. */
let requestTouchedAt: Map<number, number>;
/** The open-request lock: each key's queue of waiting raises. */
let locks: Map<string, Promise<unknown>>;
let requesterFault: boolean;
/** endArtefact and purgeRecords, in the order the service called them. */
let purgeLog: string[];
/** Thrown by purgeRecords (after deleting one row), as a delete still timing out after its tries would. */
let purgeFault: Error | null;
/** Artefacts another handler ends (as the given status) just before this one's END_ARTEFACT runs. */
let endedElsewhere: Map<number, "REVOKED" | "EXPIRED">;
/** Runs just before each END_ARTEFACT, as another handler (or the sweep) committing in between would. */
let beforeEnd: ((id: number, status: string, at: Date) => void | Promise<void>) | null;
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
        requestTouchedAt.set(id, now);
        return id;
    },
    async updateRequest(id, changes) {
        Object.assign(requests.find((row) => row.id === id)!, changes);
        requestTouchedAt.set(id, now);
    },
    async listWaitingRequests({ raisedAfter, raisedBefore, checkedBefore, limit }) {
        return requests.filter((row) => row.status === "REQUESTED" && row.consentRequestId && row.hiuId
            && new Date(row.createdAt).getTime() <= raisedBefore.getTime() && new Date(row.createdAt).getTime() >= raisedAfter.getTime()
            && (requestTouchedAt.get(row.id) ?? 0) <= checkedBefore.getTime())
            .sort((a, b) => (requestTouchedAt.get(a.id) ?? 0) - (requestTouchedAt.get(b.id) ?? 0) || a.id - b.id)
            .slice(0, limit).map(withName);
    },
    async claimStatusCheck({ id, requestId, at, checkedBefore }) {
        // One atomic UPDATE in the database: the check and the change happen together.
        const row = requests.find((r) => r.id === id)!;
        if (row.status !== "REQUESTED" || (requestTouchedAt.get(id) ?? 0) > checkedBefore.getTime()) return false;
        row.statusRequestId = requestId;
        requestTouchedAt.set(id, at.getTime());
        return true;
    },
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
                recordsPurgedAt: status === "GRANTED" ? null : at, createdAt: at, transfer: null, recordCount: 0,
            });
            touchedAt.set(ids, at.getTime());
        }
    },
    async claimFetch(id, requestId, at) {
        const artefact = artefacts.find((a) => a.id === id)!;
        if (artefact.fetchRequestId || artefact.fetchedAt || artefact.status !== "GRANTED") return false;
        artefact.fetchRequestId = requestId;
        fetchAttempts.set(id, (fetchAttempts.get(id) ?? 0) + 1);
        artefact.fetchAttempts = fetchAttempts.get(id);
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
        artefact.fetchAttempts = fetchAttempts.get(artefactId);
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
        // Status, key and care contexts only, and only while GRANTED (or CLOSED, taking ABDM's REVOKED
        // or EXPIRED), like END_ARTEFACT: the records stay until purgeRecords.
        await beforeEnd?.(id, status, at);
        privateKeys.set(id, null);
        const artefact = artefacts.find((a) => a.id === id)!;
        if (endedElsewhere.has(id)) Object.assign(artefact, { status: endedElsewhere.get(id), statusAt: at });
        const fromClosed = artefact.status === "CLOSED" && (status === "REVOKED" || status === "EXPIRED");
        if (artefact.status !== "GRANTED" && !fromClosed) return false;
        Object.assign(artefact, { status, statusAt: at });
        purgeLog.push(status === "CLOSED" ? `close ${id}` : `end ${id}`);
        return true;
    },
    async listLapsedArtefacts({ now: at, limit, maxFetchAttempts }) {
        // As LIST_LAPSED_ARTEFACTS: its granted delete-by time, else its request's when it was stored
        // before it or its fetches are spent; an artefact with no request row counts by its own only.
        const lapsedAt = (artefact: ArtefactWithTransfer) => {
            const row = requests.find((r) => r.id === artefact.consentRequestFk) ?? null;
            const storedAfter = row && artefact.createdAt && new Date(artefact.createdAt).getTime() >= new Date(row.dataEraseAt).getTime();
            if (!artefact.dataEraseAt && storedAfter && (artefact.fetchAttempts ?? 0) < maxFetchAttempts) return null;
            return artefact.dataEraseAt ?? row?.dataEraseAt ?? null;
        };
        return artefacts.filter((artefact) => artefact.status === "GRANTED" && lapsedAt(artefact) && new Date(lapsedAt(artefact)!).getTime() <= at.getTime())
            .sort((x, y) => new Date(lapsedAt(x)!).getTime() - new Date(lapsedAt(y)!).getTime() || x.id - y.id)
            .slice(0, limit).map((artefact) => ({ ...artefact, lapsedAt: new Date(lapsedAt(artefact)!) }));
    },
    async expireEmptyRequests(at) {
        const due = requests.filter((row) => row.status === "GRANTED" && new Date(row.dataEraseAt).getTime() <= at.getTime()
            && !artefacts.some((artefact) => artefact.consentRequestFk === row.id));
        for (const row of due) Object.assign(row, { status: "EXPIRED", statusAt: new Date(row.dataEraseAt) });
        return due.map((row) => ({ id: row.id, hospitalId: row.hospitalId, consentRequestId: row.consentRequestId, statusAt: row.statusAt }));
    },
    async listUnsettledRequests(limit) {
        // As LIST_UNSETTLED_REQUESTS, clause by clause.
        const of = (row: ConsentRequestRow) => artefacts.filter((artefact) => artefact.consentRequestFk === row.id);
        const ended = (artefact: ArtefactWithTransfer) => artefact.status === "REVOKED" || artefact.status === "EXPIRED";
        const time = (date: Date | null | undefined) => new Date(date!).getTime();
        const endedBefore = (row: ConsentRequestRow) => of(row).some((artefact) => ended(artefact)
            && (time(artefact.statusAt) < time(row.statusAt) || (time(artefact.statusAt) === time(row.statusAt) && artefact.status === "REVOKED" && row.status === "EXPIRED")));
        const closedAfterLapse = (row: ConsentRequestRow) => of(row).some((artefact) => {
            const deleteBy = time(artefact.dataEraseAt ?? row.dataEraseAt);
            return artefact.status === "CLOSED" && deleteBy <= time(artefact.statusAt) && time(artefact.createdAt) < deleteBy;
        });
        return requests.filter((row) => row.status === "PARTLY_REVOKED"
            || (row.status === "GRANTED" && of(row).some(ended))
            || ((row.status === "REVOKED" || row.status === "EXPIRED") && of(row).some(ended) && of(row).some((artefact) => artefact.status === "GRANTED"))
            || ((row.status === "REVOKED" || row.status === "EXPIRED") && endedBefore(row))
            || closedAfterLapse(row))
            .slice(0, limit).map(withName);
    },
    async purgeRecords(id, at) {
        // What the caller had already sent (the acknowledgement) and saw ended when the purge began.
        purgeLog.push(`purge ${id} after ${pathsCalled().at(-1) ?? "-"} (${artefacts.find((a) => a.id === id)!.status})`);
        const artefact = artefacts.find((a) => a.id === id)!;
        if (artefact.status === "GRANTED") return 0;
        if (purgeFault) {
            // One row went before the failure; the rest stay for the sweep.
            const index = records.findIndex((record) => record.artefactFk === id);
            if (index >= 0) records.splice(index, 1);
            throw new RecordPurgeError(index >= 0 ? 1 : 0, purgeFault);
        }
        const before = records.length;
        records = records.filter((record) => record.artefactFk !== id);
        if (!artefact.recordsPurgedAt) artefact.recordsPurgedAt = at;
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
    purgeLog = [];
    purgeFault = null;
    endedElsewhere = new Map();
    beforeEnd = null;
    fetchAttempts = new Map();
    touchedAt = new Map();
    requestTouchedAt = new Map();
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

test("the refusal names the waiting request, the types it already asks for and the types still free", async () => {
    const first = await raised();
    const refused = await service.create(ctx, input({ hiTypes: ["OPConsultation", "Invoice", "Prescription", "WellnessRecord"] })).catch((error) => error);
    assert.ok(refused instanceof HiuError && refused.kind === "conflict" && refused.status === 409);
    assert.equal(refused.message, "An earlier request for this patient and purpose is still waiting for their answer, and it already asks for OP consultation and Prescription.");
    assert.deepEqual(refused.details, {
        id: first.id,
        status: "REQUESTED",
        waitingSince: first.createdAt.toISOString(),
        openRequests: 1,
        openIds: [first.id],
        overlappingHiTypes: ["OPConsultation", "Prescription"],
        freeHiTypes: ["Invoice", "WellnessRecord"],
    });
    assert.equal(calls.length, 1);
});

test("with two open requests the refusal names the oldest and counts the record types of both", async () => {
    const first = await raised();
    now += 60_000;
    await service.create(ctx, input({ hiTypes: ["Invoice"] }));
    const refused = await service.create(ctx, input({ hiTypes: ["Invoice", "OPConsultation", "WellnessRecord"] })).catch((error) => error);
    assert.ok(refused instanceof HiuError && refused.kind === "conflict");
    assert.equal(refused.message, "Earlier requests for this patient and purpose are still open, and they already ask for Invoice and OP consultation.");
    const details = refused.details!;
    assert.equal(details.id, first.id);
    assert.equal(details.openRequests, 2);
    assert.deepEqual(details.overlappingHiTypes, ["Invoice", "OPConsultation"]);
    assert.deepEqual(details.freeHiTypes, ["WellnessRecord"]);
});

test("staff told of an open request may send anyway, and the patient gets both", async () => {
    const first = await raised();
    const warned = await service.create(ctx, input({ hiTypes: ["OPConsultation", "Invoice"] })).catch((error) => error);
    assert.deepEqual(warned.details.openIds, [first.id]);
    const second = await service.create(ctx, input({ hiTypes: ["OPConsultation", "Invoice"], acknowledgedOpenRequestIds: warned.details.openIds }));
    assert.equal(second.status, "SENDING");
    assert.equal(requests.length, 2);
    assert.deepEqual(pathsCalled(), ["request/init", "request/init"]);
    // The audit says it was sent past the open request staff were shown.
    assert.ok(audits.some((event) => event.event === "CONSENT_INIT" && event.outcome === "OK" && event.detail === `CAREMGT 2 types; sent past open #${first.id}`));
});

test("send anyway goes past only the open requests staff were shown; one raised meanwhile warns again", async () => {
    const first = await raised();
    const warned = await service.create(ctx, input({ hiTypes: ["OPConsultation", "Invoice"] })).catch((error) => error);
    // Meanwhile another member of staff raises an Invoice request for the same patient and purpose.
    now += 60_000;
    const meanwhile = await service.create(ctx, input({ hiTypes: ["Invoice"], acknowledgedOpenRequestIds: [] }));
    now += 60_000;
    const again = await service.create(ctx, input({ hiTypes: ["OPConsultation", "Invoice"], acknowledgedOpenRequestIds: warned.details.openIds })).catch((error) => error);
    assert.ok(again instanceof HiuError && again.kind === "conflict");
    assert.deepEqual(again.details!.openIds, [first.id, meanwhile.id]);
    assert.equal(requests.length, 2);
    await service.create(ctx, input({ hiTypes: ["OPConsultation", "Invoice"], acknowledgedOpenRequestIds: [first.id, meanwhile.id] }));
    assert.equal(requests.length, 3);
});

test("the same request is never sent twice: not on a second press of Send, nor while ABDM has not confirmed it", async () => {
    const first = await service.create(ctx, input());
    now += 3_000;
    const again = await service.create(ctx, input({ acknowledgedOpenRequestIds: [first.id] })).catch((error) => error);
    assert.ok(again instanceof HiuError && again.kind === "conflict" && again.status === 409);
    assert.equal(again.message, "The same request was sent a moment ago. Check the list before sending it again.");
    assert.deepEqual(again.details, { id: first.id });
    // Past the 10 seconds, but ABDM has still not confirmed it: it may have reached the patient.
    now += 8_000;
    const unconfirmed = await service.create(ctx, input({ acknowledgedOpenRequestIds: [first.id] })).catch((error) => error);
    assert.equal(unconfirmed.message, "The same request is still being sent to ABDM, which has not confirmed it yet. Check the list in a few minutes before sending it again.");
    assert.equal(requests.length, 1);
    // Once ABDM has confirmed it, staff told of it may raise it again.
    await service.onInit({ consentRequest: { id: CONSENT_REQUEST }, error: null, response: { requestId: requests[0]!.initRequestId } }, headers("cb-init"));
    await service.create(ctx, input({ acknowledgedOpenRequestIds: [first.id] }));
    assert.equal(requests.length, 2);
});

test("the same record types with other dates is another request, not a second press of Send", async () => {
    const first = await service.create(ctx, input());
    now += 2_000;
    const warned = await service.create(ctx, input({ dateFrom: "2026-06-01" })).catch((error) => error);
    assert.deepEqual(warned.details.openIds, [first.id]);
    await service.create(ctx, input({ dateFrom: "2026-06-01", acknowledgedOpenRequestIds: [first.id] }));
    assert.equal(requests.length, 2);
});

test("two presses of Send anyway at once send the patient one request", async () => {
    const first = await raised();
    now += 60_000;
    const extra = { hiTypes: ["OPConsultation", "Invoice"], acknowledgedOpenRequestIds: [first.id] };
    const results = await Promise.allSettled([service.create(ctx, input(extra)), service.create(ctx, input(extra))]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(requests.length, 2);
    assert.deepEqual(pathsCalled(), ["request/init", "request/init"]);
});

test("a refusal for a request ABDM has not confirmed says it is still being sent", async () => {
    gatewayFault = () => initTimeout();
    await service.create(ctx, input()).catch(() => null);
    gatewayFault = null;
    const refused = await service.create(ctx, input({ hiTypes: ["Prescription"] })).catch((error) => error);
    assert.equal(refused.message, "An earlier request for this patient and purpose is still being sent to ABDM, and it already asks for Prescription.");
    assert.equal(refused.details.status, "SENDING");
});

test("a request still REQUESTED after its delete-by time no longer blocks a new one", async () => {
    await raised();
    assert.equal(requests[0]!.status, "REQUESTED");
    const warned = await service.create(ctx, input({ dataEraseAt: "2027-01-31T23:59:00+05:30" })).catch((error) => error);
    assert.equal(warned.details.openRequests, 1);
    // ABDM sent no lapse notice, so it is still REQUESTED here, but its delete-by time has passed.
    now = requests[0]!.dataEraseAt.getTime() + 1;
    await service.create(ctx, input({ dataEraseAt: "2027-01-31T23:59:00+05:30" }));
    assert.equal(calls.length, 2);
    assert.equal(requests[0]!.status, "REQUESTED");
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
    // It still counts as open for a new request for the same need, after the double-submit window.
    gatewayFault = null;
    now += 11_000;
    const warned = await service.create(ctx, input()).catch((error) => error);
    assert.ok(warned instanceof HiuError && warned.kind === "conflict" && warned.status === 409);
    assert.deepEqual(warned.details!.openIds, [requests[0]!.id]);
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

const statusCalls = () => calls.filter(({ call }) => call.path === "/api/hiecm/consent/v3/request/status").map(({ call }) => call);

test("a request still waiting an hour after it was raised is asked about by the sweep, every 15 minutes, until ABDM ends it", async () => {
    const row = await raised();
    now += 30 * 60_000;
    assert.equal(await service.checkWaitingRequests(), 0, "not before an hour");
    now += 31 * 60_000;
    assert.equal(await service.checkWaitingRequests(), 1);
    const [first] = statusCalls();
    assert.equal(first!.headers?.["X-HIU-ID"], HIU_ID);
    assert.deepEqual(first!.body, { consentRequestId: CONSENT_REQUEST });
    assert.equal(row.statusRequestId, first!.requestId);
    // A sweep's check writes no audit row of its own: its answer is audited as ON_STATUS.
    assert.ok(!audits.some((event) => event.event === "STATUS_REQUEST"));
    assert.equal(await service.checkWaitingRequests(), 0, "asked once, not on every sweep");

    // ABDM still says REQUESTED: asked again 15 minutes later, not before.
    await service.onStatus({ consentRequest: { id: CONSENT_REQUEST, status: "REQUESTED" }, error: null, response: { requestId: first!.requestId } }, headers("cb-s1"));
    now += 14 * 60_000;
    assert.equal(await service.checkWaitingRequests(), 0);
    now += 2 * 60_000;
    assert.equal(await service.checkWaitingRequests(), 1);
    const second = statusCalls()[1]!;

    // ABDM has ended it: Expired here too, and never asked about again.
    await service.onStatus({ consentRequest: { id: CONSENT_REQUEST, status: "EXPIRED" }, error: null, response: { requestId: second.requestId } }, headers("cb-s2"));
    assert.equal(row.status, "EXPIRED");
    assert.ok(audits.some((event) => event.event === "ON_STATUS" && event.outcome === "EXPIRED"));
    now += 16 * 60_000;
    assert.equal(await service.checkWaitingRequests(), 0);
    assert.equal(statusCalls().length, 2);
});

test("a waiting request is asked about less often as it ages: hourly from 3 hours, every 6 hours from its second day", async () => {
    await raised();
    now += 4 * 60 * 60_000;
    assert.equal(await service.checkWaitingRequests(), 1);
    now += 30 * 60_000;
    assert.equal(await service.checkWaitingRequests(), 0, "hourly at 4 hours old");
    now += 31 * 60_000;
    assert.equal(await service.checkWaitingRequests(), 1);
    now += 2 * 24 * 60 * 60_000;
    assert.equal(await service.checkWaitingRequests(), 1);
    now += 5 * 60 * 60_000;
    assert.equal(await service.checkWaitingRequests(), 0, "every 6 hours from the second day");
    now += 61 * 60_000;
    assert.equal(await service.checkWaitingRequests(), 1);
    assert.equal(statusCalls().length, 4);
});

test("a request staff refreshed less than 15 minutes ago is not asked about again by the sweep", async () => {
    const row = await raised();
    now += 55 * 60_000;
    await service.refreshStatus(ctx, row.id);
    now += 10 * 60_000;
    assert.equal(await service.checkWaitingRequests(), 0);
    now += 6 * 60_000;
    assert.equal(await service.checkWaitingRequests(), 1);
    assert.equal(statusCalls().length, 2);
});

test("a request answered between the sweep's read and its claim is not asked about", async () => {
    const row = await raised();
    now += 61 * 60_000;
    const read = store.listWaitingRequests;
    store.listWaitingRequests = async (input) => {
        const rows = await read(input);
        row.status = "GRANTED";
        return rows;
    };
    try {
        assert.equal(await service.checkWaitingRequests(), 0);
    } finally {
        store.listWaitingRequests = read;
    }
    assert.equal(statusCalls().length, 0);
});

test("the sweep asks only as the hospital's HIU today, and never about a request with no HIU id", async () => {
    const row = await raised();
    now += 61 * 60_000;
    row.hiuId = null;
    assert.equal(await service.checkWaitingRequests(), 0);
    // Raised as an HIU id that is now another hospital's: an answer to it would be refused.
    row.hiuId = HIU_B;
    assert.equal(await service.checkWaitingRequests(), 0);
    assert.equal(statusCalls().length, 0);
    row.hiuId = HIU_ID;
    assert.equal(await service.checkWaitingRequests(), 1);
});

test("when ABDM gives no answer the sweep stops asking until its next run", async () => {
    await raised();
    const other = await service.create(ctx, input({ purposeCode: "PATRQT" }));
    const otherRow = requests.find((r) => r.id === other.id)!;
    await service.onInit({ consentRequest: { id: "cr-other" }, error: null, response: { requestId: otherRow.initRequestId } }, headers("cb-other"));
    gatewayFault = (call) => (call.path.endsWith("/request/status") ? initTimeout() : null);
    now += 61 * 60_000;
    assert.equal(await service.checkWaitingRequests(), 0);
    assert.equal(statusCalls().length, 1, "the second request waits for the next sweep");
    assert.ok(audits.some((event) => event.event === "STATUS_REQUEST" && event.outcome === "FAILED" && event.staffUserId === null));
});

test("two sweeps at once, as from two instances, ask ABDM about a waiting request once", async () => {
    await raised();
    now += 61 * 60_000;
    const asked = await Promise.all([service.checkWaitingRequests(), service.checkWaitingRequests()]);
    assert.equal(asked[0] + asked[1], 1);
    assert.equal(statusCalls().length, 1);
});

test("the sweep leaves alone requests raised over a week ago, and does nothing while the HIU is not configured", async () => {
    await raised();
    now += 61 * 60_000;
    settings = { ...settings, configured: false };
    assert.equal(await service.checkWaitingRequests(), 0);
    settings = { ...settings, configured: true };
    now += 8 * 24 * 60 * 60_000;
    assert.equal(await service.checkWaitingRequests(), 0);
    assert.equal(statusCalls().length, 0);
});

test("a status check ABDM refuses is audited, and the sweep still asks about the other waiting requests", async () => {
    await raised();
    const other = await service.create(ctx, input({ purposeCode: "PATRQT" }));
    const otherRow = requests.find((r) => r.id === other.id)!;
    await service.onInit({ consentRequest: { id: "cr-other" }, error: null, response: { requestId: otherRow.initRequestId } }, headers("cb-other"));
    gatewayFault = (call) => (call.path.endsWith("/request/status") && (call.body as any).consentRequestId === CONSENT_REQUEST
        ? new AbdmApiError({ status: 400, kind: "rejected", operation: "consent/v3/request/status", code: "ABDM-1001", message: "Invalid request" })
        : null);
    now += 61 * 60_000;
    // One refused, one sent: only the one sent counts.
    assert.equal(await service.checkWaitingRequests(), 1);
    assert.deepEqual(statusCalls().map((call) => (call.body as any).consentRequestId).sort(), [CONSENT_REQUEST, "cr-other"].sort());
    assert.ok(audits.some((event) => event.event === "STATUS_REQUEST" && event.outcome === "REJECTED" && event.staffUserId === null));
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

test("a refused acknowledgement is audited with ABDM's message beside its code, digits masked", async () => {
    await raised();
    gatewayFault = (call) => call.path.endsWith("/hiu/on-notify")
        ? new AbdmApiError({ status: 400, kind: "rejected", operation: "consent/v3/request/hiu/on-notify", code: "ABDM-9999", message: "Acknowledgment should not be null or empty 1234567890" })
        : null;
    await notify("DENIED", [], "notify-denied");
    const row = audits.find((event) => event.event === "ON_NOTIFY_SENT")!;
    assert.equal(row.outcome, "FAILED");
    assert.equal(row.detail, "ABDM-9999: Acknowledgment should not be null or empty [digits]");
});

test("a notification for a consent request we do not hold is dropped, unacknowledged", async () => {
    await raised();
    await notify("GRANTED", [ARTEFACT_A], "foreign", "eeeeeeee-0000-4000-8000-00000000000e");
    assert.equal(artefacts.length, 0);
    assert.deepEqual(pathsCalled(), ["request/init"]);
    assert.ok(audits.some((event) => event.event === "NOTIFY_GRANTED" && event.outcome === "IGNORED" && event.hospitalId === null));
});

test("REVOKED of one facility ends the whole request: the other is CLOSED, and ABDM's acknowledgement names only the revoked one", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    const [a, b] = artefacts;
    records.push({ artefactFk: a!.id }, { artefactFk: a!.id }, { artefactFk: b!.id });
    privateKeys.set(a!.id, "sealed-key");
    privateKeys.set(b!.id, "sealed-key");
    const fetchesBefore = pathsCalled().filter((path) => path === "fetch").length;

    // A revocation names only the artefacts (the spec's REVOKED carries consentArtefacts).
    now += 60_000;
    const revokedAt = now;
    await notify("REVOKED", [ARTEFACT_A], "revoke-1", null);
    assert.equal(a!.status, "REVOKED");
    assert.equal(b!.status, "CLOSED", "ClinicX's own status: ABDM still holds it as granted");
    assert.equal(row.status, "REVOKED");
    assert.equal(new Date(row.statusAt).getTime(), revokedAt, "since the revocation");
    assert.deepEqual(records, [], "no record of the request is left, the other facility's included");
    assert.ok(a!.recordsPurgedAt && b!.recordsPurgedAt);
    assert.equal(privateKeys.get(a!.id), null);
    assert.equal(privateKeys.get(b!.id), null);
    assert.deepEqual(calls.at(-1)!.call.body, { acknowledgement: [{ status: "OK", consentId: ARTEFACT_A }], response: { requestId: "revoke-1" } });
    // Both end (access stops) before ABDM is answered; both are deleted only after.
    assert.deepEqual(purgeLog, [
        `end ${a!.id}`,
        `close ${b!.id}`,
        `purge ${a!.id} after request/hiu/on-notify (REVOKED)`,
        `purge ${b!.id} after request/hiu/on-notify (CLOSED)`,
    ]);
    assert.deepEqual(audits.filter((event) => event.event === "ARTEFACT_CLOSED").map((event) => [event.artefactId, event.consentRequestId, event.outcome, event.detail]), [
        [ARTEFACT_B, CONSENT_REQUEST, "OK", "request ended: another provider was revoked"],
    ]);
    assert.deepEqual(audits.filter((event) => event.event === "RECORD_PURGED").map((event) => [event.artefactId, event.detail]), [
        [ARTEFACT_A, "REVOKED: 2 records"],
        [ARTEFACT_B, "CLOSED: 1 records"],
    ]);

    // Repeated: nothing more happens.
    await notify("REVOKED", [ARTEFACT_A], "revoke-1", null);
    assert.equal(audits.filter((event) => event.event === "RECORD_PURGED").length, 2);
    assert.equal(audits.filter((event) => event.event === "ARTEFACT_CLOSED").length, 1);

    // ABDM's own REVOKED for the closed one later: its card takes ABDM's word, and ABDM is answered.
    now += 60_000;
    await notify("REVOKED", [ARTEFACT_B], "revoke-2");
    assert.equal(b!.status, "REVOKED");
    assert.equal(new Date(b!.statusAt).getTime(), now);
    assert.deepEqual(calls.at(-1)!.call.body, { acknowledgement: [{ status: "OK", consentId: ARTEFACT_B }], response: { requestId: "revoke-2" } });
    assert.equal(row.status, "REVOKED");
    assert.equal(new Date(row.statusAt).getTime(), revokedAt, "the request still ended at the first revocation");
    assert.equal(audits.filter((event) => event.event === "RECORD_PURGED").length, 2, "its records went when it was closed");
    assert.equal(pathsCalled().filter((path) => path === "fetch").length, fetchesBefore, "a revocation never fetches");

    const detail = await service.detail(ctx, row.id);
    assert.deepEqual(detail.artefacts.map((artefact) => [artefact.status, artefact.stage]), [["REVOKED", "BLOCKED"], ["REVOKED", "BLOCKED"]]);
    assert.ok(detail.events.some((event) => event.event === "ARTEFACT_CLOSED"), "History shows ClinicX closing it");
    // A GRANTED arriving late (out of order) does not reopen the request, and fetches nothing.
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B], "late-grant");
    assert.equal(row.status, "REVOKED");
    assert.deepEqual(artefacts.map((artefact) => artefact.status), ["REVOKED", "REVOKED"]);
    assert.equal(pathsCalled().filter((path) => path === "fetch").length, fetchesBefore);
});

test("a closed facility's own EXPIRED from ABDM shows on its card; the request keeps how it ended first", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    const [a, b] = artefacts;
    const revokedAt = now;
    await notify("REVOKED", [ARTEFACT_A], "revoke-a", null);
    assert.equal(b!.status, "CLOSED");
    now += 60_000;
    await notify("EXPIRED", [ARTEFACT_B], "expire-b");
    assert.equal(b!.status, "EXPIRED");
    assert.equal(a!.status, "REVOKED");
    assert.equal(row.status, "REVOKED");
    assert.equal(new Date(row.statusAt).getTime(), revokedAt);
    assert.deepEqual(calls.at(-1)!.call.body, { acknowledgement: [{ status: "OK", consentId: ARTEFACT_B }], response: { requestId: "expire-b" } });
});

test("a GRANTED notify adding artefacts to a request already ended stores them CLOSED and fetches nothing", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A]);
    await notify("REVOKED", [ARTEFACT_A], "revoke", null);
    const fetches = pathsCalled().filter((path) => path === "fetch").length;

    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B], "late-grant");
    const b = artefacts.find((artefact) => artefact.consentArtefactId === ARTEFACT_B)!;
    assert.equal(b.status, "CLOSED");
    assert.ok(b.recordsPurgedAt, "nothing can be received under it");
    assert.equal(row.status, "REVOKED");
    // ABDM is answered for every artefact it named, as for any GRANTED.
    assert.deepEqual(calls.at(-1)!.call.body, {
        acknowledgement: [{ status: "OK", consentId: ARTEFACT_A }, { status: "OK", consentId: ARTEFACT_B }],
        response: { requestId: "late-grant" },
    });
    assert.deepEqual(audits.filter((event) => event.event === "ARTEFACT_CLOSED").map((event) => [event.artefactId, event.detail]), [
        [ARTEFACT_B, "granted after the request ended"],
    ]);
    assert.equal(pathsCalled().filter((path) => path === "fetch").length, fetches);
    now += 60 * 60_000;
    assert.equal(await service.retryFetches(), 0);
});

test("REVOKED commits the artefact's end and acknowledges ABDM before its records are deleted", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A]);
    const [a] = artefacts;
    records.push({ artefactFk: a!.id }, { artefactFk: a!.id });

    await notify("REVOKED", [ARTEFACT_A], "revoke-1", null);
    // Ended (access stops), then the request's status, then on-notify, and only then the delete.
    assert.deepEqual(purgeLog, [`end ${a!.id}`, `purge ${a!.id} after request/hiu/on-notify (REVOKED)`]);
    assert.equal(row.status, "REVOKED");
    assert.deepEqual(records, []);
    assert.ok(a!.recordsPurgedAt);
    assert.deepEqual(audits.filter((event) => event.event === "RECORD_PURGED").map((event) => [event.artefactId, event.outcome, event.detail]), [
        [ARTEFACT_A, "OK", "REVOKED: 2 records"],
    ]);
});

test("an artefact another handler ended first is neither overwritten nor purged twice; the notify is still acknowledged", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A]);
    const [a] = artefacts;
    records.push({ artefactFk: a!.id });
    endedElsewhere.set(a!.id, "EXPIRED");
    await notify("REVOKED", [ARTEFACT_A], "revoke-1", null);
    assert.equal(a!.status, "EXPIRED", "the first ending stands");
    assert.deepEqual(purgeLog, [], "this handler deletes nothing: the other one (or the sweep) does");
    assert.equal(row.status, "EXPIRED");
    assert.deepEqual(calls.at(-1)!.call.body, { acknowledgement: [{ status: "OK", consentId: ARTEFACT_A }], response: { requestId: "revoke-1" } });
});

test("a revocation whose records cannot all be deleted still stands, is acknowledged, and leaves the rest to the sweep", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A]);
    const [a] = artefacts;
    records.push({ artefactFk: a!.id }, { artefactFk: a!.id });
    purgeFault = Object.assign(new Error("Timeout: Request failed to complete in 30000ms"), { code: "ETIMEOUT" });

    await notify("REVOKED", [ARTEFACT_A], "revoke-1", null);
    assert.equal(a!.status, "REVOKED");
    assert.equal(row.status, "REVOKED");
    assert.equal(privateKeys.get(a!.id), null);
    assert.deepEqual(calls.at(-1)!.call.body, { acknowledgement: [{ status: "OK", consentId: ARTEFACT_A }], response: { requestId: "revoke-1" } });
    assert.ok(audits.some((event) => event.event === "ON_NOTIFY_SENT" && event.outcome === "OK"));
    assert.equal(records.length, 1, "what the purge did not reach waits for the sweep");
    assert.equal(a!.recordsPurgedAt, null);
    assert.deepEqual(audits.filter((event) => event.event === "RECORD_PURGED").map((event) => [event.outcome, event.detail]), [
        ["FAILED", "REVOKED: 1 records, then ETIMEOUT; the sweep deletes the rest"],
    ]);
    assert.ok(!audits.some((event) => String(event.detail ?? "").includes("Timeout:")), "the driver's message is never recorded");
    const detail = await service.detail(ctx, row.id);
    assert.deepEqual(detail.artefacts.map((artefact) => artefact.stage), ["BLOCKED"]);
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

test("on-fetch REVOKED for one facility ends the whole request: the other is CLOSED, nothing is asked for and no records are left", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    const [a, b] = artefacts;
    records.push({ artefactFk: a!.id }, { artefactFk: b!.id });
    await service.onFetch({ ...onFetchBody(fetchRequestIdOf(ARTEFACT_A), ARTEFACT_A), consent: { status: "REVOKED", consentDetail: null, signature: "" } }, headers("f"));
    assert.equal(a!.status, "REVOKED");
    assert.equal(b!.status, "CLOSED");
    assert.equal(row.status, "REVOKED");
    assert.deepEqual(requested, []);
    assert.deepEqual(records, [], "the revoked facility's records and the closed one's are deleted");
    assert.ok(audits.some((event) => event.event === "ARTEFACT_CLOSED" && event.artefactId === ARTEFACT_B));

    // The closed facility's own answer, GRANTED, arriving after: nothing is stored or asked for.
    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_B), ARTEFACT_B), headers("f2"));
    assert.equal(b!.status, "CLOSED");
    assert.equal(b!.fetchedAt, null);
    assert.deepEqual(requested, []);
});

test("on-fetch DENIED for one facility while another is still granted leaves the request GRANTED; nothing is closed", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    const [a, b] = artefacts;
    records.push({ artefactFk: b!.id });
    const denied = (requestId: string, consentId: string) => ({ ...onFetchBody(requestId, consentId), consent: { status: "DENIED", consentDetail: null, signature: "" } });

    await service.onFetch(denied(fetchRequestIdOf(ARTEFACT_A), ARTEFACT_A), headers("f"));
    assert.equal(a!.status, "DENIED", "the denied facility shows Denied on its own card");
    assert.equal(b!.status, "GRANTED");
    assert.equal(row.status, "GRANTED", "a denial is not an ending: the other facility stays usable");
    assert.equal(records.length, 1, "the granted facility's records stay");
    assert.ok(!audits.some((event) => event.event === "ARTEFACT_CLOSED"));
    assert.equal(await service.settleRequests(), 0);

    // Once no facility is granted any more, the request is DENIED.
    await service.onFetch(denied(fetchRequestIdOf(ARTEFACT_B), ARTEFACT_B), headers("f2"));
    assert.equal(b!.status, "DENIED");
    assert.equal(row.status, "DENIED");
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
    // No longer a status: a legacy row is settled by the sweep, never filtered for.
    await assertRefused(service.list(ctx, { page: 1, pageSize: 20, status: "PARTLY_REVOKED" }), "validation", 400);
    for (const status of ["SENDING", "REQUESTED", "GRANTED", "DENIED", "EXPIRED", "REVOKED", "FAILED"]) {
        assert.equal((await service.list(ctx, { page: 1, pageSize: 20, status })).total, status === "REQUESTED" ? 1 : 0);
    }
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
    for (const status of ["REVOKED", "EXPIRED", "DENIED", "CLOSED"] as const) {
        assert.equal(artefactStage({ ...base, status, recordsPurgedAt: new Date(now) }, now), "BLOCKED");
    }
});

test("a request's status is how it ended first: any facility revoked or lapsed ends it, CLOSED never decides", () => {
    const at = (minutes: number) => new Date(now + minutes * 60_000);
    const G = (minutes = 0) => ({ status: "GRANTED" as const, statusAt: at(minutes) });
    const R = (minutes = 0) => ({ status: "REVOKED" as const, statusAt: at(minutes) });
    const E = (minutes = 0) => ({ status: "EXPIRED" as const, statusAt: at(minutes) });
    const C = (minutes = 0) => ({ status: "CLOSED" as const, statusAt: at(minutes) });
    const D = (minutes = 0) => ({ status: "DENIED" as const, statusAt: at(minutes) });

    assert.equal(requestStatusFrom([]), null);
    assert.equal(requestStatusFrom([G(), G()]), "GRANTED");
    assert.equal(requestStatusFrom([G(), R(1)]), "REVOKED");
    assert.equal(requestStatusFrom([G(), E(1)]), "EXPIRED");
    assert.equal(requestStatusFrom([R(5), E(1)]), "EXPIRED", "a revocation after the consent lapsed leaves it lapsed");
    assert.equal(requestStatusFrom([R(1), E(5)]), "REVOKED");
    assert.equal(requestStatusFrom([E(1), R(1)]), "REVOKED", "at the same moment the revocation counts");
    assert.equal(requestStatusFrom([G(), C(2), R(1)]), "REVOKED");
    assert.equal(requestStatusFrom([C(0), E(1)]), "EXPIRED");
    assert.equal(requestStatusFrom([E(1)]), "EXPIRED");
    // A denial is not an ending: while any facility is still granted the request is GRANTED, and
    // only DENIED when none is.
    assert.equal(requestStatusFrom([D()]), "DENIED");
    assert.equal(requestStatusFrom([D(), D(1)]), "DENIED");
    assert.equal(requestStatusFrom([G(), D()]), "GRANTED", "the denied facility shows Denied on its own card; the others stay usable");
    assert.equal(requestStatusFrom([D(), G()]), "GRANTED");
    assert.equal(requestStatusFrom([G(), D(), R(1)]), "REVOKED", "an ending still decides");
    assert.equal(requestStatusFrom([D(), E(2), R(3)]), "EXPIRED", "by the first ending");

    assert.deepEqual(requestEnding([R(5), E(1), C(0)]), { status: "EXPIRED", at: at(1) });
    assert.equal(requestEnding([G(), C(), D()]), null);

    // Never a partial status, whatever the mix.
    const kinds = [G, R, E, C, D];
    for (const x of kinds) for (const y of kinds) for (const z of kinds) {
        assert.notEqual(requestStatusFrom([x(1), y(2), z(3)]) as string, "PARTLY_REVOKED");
    }
});

// ---- the sweep: consents past their delete-by time, and requests to settle ----

const GRANTED_ERASE_AT = "2026-11-30T00:00:00.000Z";
/** The request's own delete-by time (the form's 2026-12-31 23:59 IST). */
const REQUEST_ERASE_AT = "2026-12-31T18:29:00.000Z";
const lapsedAudits = () => audits.filter((event) => event.event === "CONSENT_LAPSED");

test("a granted consent past its delete-by time is ended by ClinicX at that time, its records deleted, with no ABDM call", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A]);
    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_A), ARTEFACT_A), headers("f"));
    const a = artefacts[0]!;
    records.push({ artefactFk: a.id }, { artefactFk: a.id });
    const callsBefore = calls.length;

    now = Date.parse(GRANTED_ERASE_AT) - 1;
    assert.equal(await service.expireLapsed(), 0, "not before its delete-by time");
    assert.equal(a.status, "GRANTED");

    // The sweep runs up to a minute after: the status still says when the consent lapsed.
    now = Date.parse(GRANTED_ERASE_AT) + 40_000;
    assert.equal(await service.expireLapsed(), 1);
    assert.equal(a.status, "EXPIRED");
    assert.equal(new Date(a.statusAt).toISOString(), GRANTED_ERASE_AT);
    assert.equal(row.status, "EXPIRED");
    assert.equal(new Date(row.statusAt).toISOString(), GRANTED_ERASE_AT, "since the delete-by time, not the sweep's");
    assert.deepEqual(records, []);
    assert.ok(a.recordsPurgedAt);
    assert.equal(privateKeys.get(a.id), null);
    assert.equal(calls.length, callsBefore, "ABDM is not called: it ends a granted consent on its own clock");
    assert.deepEqual(lapsedAudits().map((event) => [event.hospitalId, event.consentRequestId, event.artefactId, event.outcome, event.detail]), [
        [19, CONSENT_REQUEST, ARTEFACT_A, "OK", "at its delete-by time, by ClinicX"],
    ]);
    assert.deepEqual(audits.filter((event) => event.event === "RECORD_PURGED").map((event) => event.detail), ["LAPSED: 2 records"]);
    const detail = await service.detail(ctx, row.id);
    assert.deepEqual(detail.artefacts.map((artefact) => [artefact.status, artefact.stage]), [["EXPIRED", "BLOCKED"]]);
    assert.ok(detail.events.some((event) => event.event === "CONSENT_LAPSED"), "History shows ClinicX ending it");

    // A second run changes nothing.
    now += 60_000;
    assert.equal(await service.expireLapsed(), 0);
    assert.equal(lapsedAudits().length, 1);

    // A later word from ABDM is acknowledged and leaves it as it ended.
    for (const status of ["REVOKED", "EXPIRED"]) {
        await notify(status, [ARTEFACT_A], `late-${status}`);
        assert.equal(a.status, "EXPIRED");
        assert.equal(row.status, "EXPIRED");
        assert.equal(new Date(row.statusAt).toISOString(), GRANTED_ERASE_AT);
        assert.deepEqual(calls.at(-1)!.call.body, { acknowledgement: [{ status: "OK", consentId: ARTEFACT_A }], response: { requestId: `late-${status}` } });
    }
    assert.ok(!audits.some((event) => /expired/i.test(String(event.detail ?? ""))), "no audit note uses the word the frontend reads as a login lapse");
});

test("the first facility to lapse ends the whole request: a later delete-by time is CLOSED with it", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_A), ARTEFACT_A), headers("fa"));
    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_B), ARTEFACT_B, { dataEraseAt: "2026-12-15T00:00:00.000Z" }), headers("fb"));
    const [a, b] = artefacts;
    records.push({ artefactFk: a!.id }, { artefactFk: b!.id }, { artefactFk: b!.id });

    now = Date.parse(GRANTED_ERASE_AT) + 30_000;
    assert.equal(await service.expireLapsed(), 1);
    assert.equal(a!.status, "EXPIRED");
    assert.equal(b!.status, "CLOSED");
    assert.equal(new Date(b!.statusAt).getTime(), now, "closed when ClinicX closed it");
    assert.equal(row.status, "EXPIRED");
    assert.equal(new Date(row.statusAt).toISOString(), GRANTED_ERASE_AT);
    assert.deepEqual(records, []);
    assert.deepEqual(audits.filter((event) => event.event === "ARTEFACT_CLOSED").map((event) => [event.artefactId, event.detail]), [
        [ARTEFACT_B, "request ended: another provider lapsed"],
    ]);
    assert.deepEqual(audits.filter((event) => event.event === "RECORD_PURGED").map((event) => [event.artefactId, event.detail]), [
        [ARTEFACT_A, "LAPSED: 1 records"],
        [ARTEFACT_B, "CLOSED: 2 records"],
    ]);

    // Its own delete-by time passing later changes nothing: it is no longer granted.
    now = Date.parse("2026-12-15T00:01:00.000Z");
    assert.equal(await service.expireLapsed(), 0);
    assert.equal(b!.status, "CLOSED");
});

test("facilities that lapse at the same time all end EXPIRED; one whose details never came lapses at the request's delete-by time", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    // A's details came (granted with the request's own delete-by time); B's never did.
    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_A), ARTEFACT_A, { dataEraseAt: REQUEST_ERASE_AT }), headers("fa"));
    const [a, b] = artefacts;
    assert.equal(b!.dataEraseAt, null);

    now = Date.parse(REQUEST_ERASE_AT) + 10_000;
    assert.equal(await service.expireLapsed(), 2);
    assert.deepEqual([a!.status, b!.status], ["EXPIRED", "EXPIRED"]);
    assert.equal(new Date(b!.statusAt).toISOString(), REQUEST_ERASE_AT);
    assert.equal(row.status, "EXPIRED");
    assert.equal(lapsedAudits().length, 2);
    assert.ok(!audits.some((event) => event.event === "ARTEFACT_CLOSED"));
    // A fetch the sweep would have retried is never sent for it now.
    assert.equal(await service.retryFetches(), 0);
});

test("a revocation after the consent lapsed leaves the request EXPIRED; the revocation still shows on its card and in History", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_A), ARTEFACT_A), headers("fa"));
    const [a, b] = artefacts;
    now = Date.parse(GRANTED_ERASE_AT) + 20_000;
    await service.expireLapsed();
    assert.equal(b!.status, "CLOSED");

    now = Date.parse(GRANTED_ERASE_AT) + 5 * 60_000;
    await notify("REVOKED", [ARTEFACT_B], "revoke-after", null);
    assert.equal(a!.status, "EXPIRED");
    assert.equal(b!.status, "REVOKED", "ABDM's word on the facility it named");
    assert.equal(row.status, "EXPIRED");
    assert.equal(new Date(row.statusAt).toISOString(), GRANTED_ERASE_AT);
    assert.ok(audits.some((event) => event.event === "NOTIFY_REVOKED" && event.outcome === "OK"));
});

test("the sweep settles a backlog the same way: a lapse before a revocation stays EXPIRED", async () => {
    // As request 64 was left: A granted and past its delete-by time at 12:10, B revoked at 12:14:54.
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_A), ARTEFACT_A), headers("fa"));
    const [a, b] = artefacts;
    const revokedAt = new Date(Date.parse(GRANTED_ERASE_AT) + 294_000);
    Object.assign(b!, { status: "REVOKED", statusAt: revokedAt, recordsPurgedAt: revokedAt });
    Object.assign(row, { status: "PARTLY_REVOKED", statusAt: revokedAt });

    now = Date.parse(GRANTED_ERASE_AT) + 24 * 60 * 60_000;
    // The sweep's order: lapsed consents, then requests to settle.
    assert.equal(await service.expireLapsed(), 1);
    assert.equal(await service.settleRequests(), 0, "already settled by the lapse");
    assert.equal(a!.status, "EXPIRED");
    assert.equal(new Date(a!.statusAt).toISOString(), GRANTED_ERASE_AT);
    assert.equal(row.status, "EXPIRED");
    assert.equal(new Date(row.statusAt).toISOString(), GRANTED_ERASE_AT);
});

// ---- endings that arrive before the sweep has recorded a lapse, and races with it ----

const ARTEFACT_C = "dddddddd-0000-4000-8000-00000000000d";
const LATER_ERASE_AT = "2026-12-15T00:00:00.000Z";

/** A request whose facility A lapses at GRANTED_ERASE_AT and B at LATER_ERASE_AT, each with records. */
const grantedTwo = async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_A), ARTEFACT_A), headers("fa"));
    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_B), ARTEFACT_B, { dataEraseAt: LATER_ERASE_AT }), headers("fb"));
    const [a, b] = artefacts;
    records.push({ artefactFk: a!.id }, { artefactFk: b!.id }, { artefactFk: b!.id });
    return { row, a: a!, b: b! };
};

test("a revocation that arrives after another facility's delete-by time, before the sweep, leaves the request EXPIRED then; the lapsed one is not CLOSED", async () => {
    const { row, a, b } = await grantedTwo();
    // A's delete-by time passed 15 s ago (as 12:10:00 and a revoke at 12:10:15); the sweep has not run yet.
    now = Date.parse(GRANTED_ERASE_AT) + 15_000;
    await notify("REVOKED", [ARTEFACT_B], "revoke-b", null);

    assert.equal(a.status, "EXPIRED");
    assert.equal(new Date(a.statusAt).toISOString(), GRANTED_ERASE_AT);
    assert.equal(b.status, "REVOKED", "the facility ABDM named keeps ABDM's word on its card");
    assert.equal(new Date(b.statusAt).getTime(), now);
    assert.equal(row.status, "EXPIRED");
    assert.equal(new Date(row.statusAt).toISOString(), GRANTED_ERASE_AT, "how it ended first: the lapse");
    assert.ok(!audits.some((event) => event.event === "ARTEFACT_CLOSED"), "nothing is CLOSED: A lapsed and B was revoked");
    assert.deepEqual(lapsedAudits().map((event) => [event.artefactId, event.detail]), [[ARTEFACT_A, "at its delete-by time, by ClinicX"]]);
    // ABDM is answered only for what it named; both facilities' records go after that.
    assert.deepEqual(calls.at(-1)!.call.body, { acknowledgement: [{ status: "OK", consentId: ARTEFACT_B }], response: { requestId: "revoke-b" } });
    assert.deepEqual(purgeLog, [`end ${a.id}`, `end ${b.id}`, `purge ${a.id} after request/hiu/on-notify (EXPIRED)`, `purge ${b.id} after request/hiu/on-notify (REVOKED)`]);
    assert.deepEqual(records, []);
    assert.deepEqual(audits.filter((event) => event.event === "RECORD_PURGED").map((event) => [event.artefactId, event.detail]), [
        [ARTEFACT_A, "LAPSED: 1 records"],
        [ARTEFACT_B, "REVOKED: 2 records"],
    ]);

    // The sweep then finds nothing left to do.
    now += 60_000;
    assert.equal(await service.expireLapsed(), 0);
    assert.equal(await service.settleRequests(), 0);
    assert.equal(row.status, "EXPIRED");
});

test("a revocation or an on-fetch REVOKED naming the facility that already lapsed, before the sweep, leaves it and the request EXPIRED", async () => {
    const { row, a, b } = await grantedTwo();
    now = Date.parse(GRANTED_ERASE_AT) + 15_000;
    await notify("REVOKED", [ARTEFACT_A], "revoke-a", null);
    assert.equal(a.status, "EXPIRED", "it had lapsed before ABDM's word");
    assert.equal(b.status, "CLOSED");
    assert.equal(row.status, "EXPIRED");
    assert.equal(new Date(row.statusAt).toISOString(), GRANTED_ERASE_AT);
    assert.deepEqual(calls.at(-1)!.call.body, { acknowledgement: [{ status: "OK", consentId: ARTEFACT_A }], response: { requestId: "revoke-a" } });

    // The same through on-fetch, on a second request: C lapsed at the request's own delete-by time
    // (its details never came), D's on-fetch answers REVOKED after it.
    const second = await service.create(ctx, input({ purposeCode: "PUBHLTH" }));
    const secondRow = requests.find((r) => r.id === second.id)!;
    await service.onInit({ consentRequest: { id: "eeeeeeee-1111-4000-8000-00000000000e" }, error: null, response: { requestId: secondRow.initRequestId } }, headers("cb-init-2"));
    await notify("GRANTED", [ARTEFACT_C, "ffffffff-1111-4000-8000-00000000000f"], "grant-2", "eeeeeeee-1111-4000-8000-00000000000e");
    const [c, d] = artefacts.filter((artefact) => artefact.consentRequestFk === secondRow.id);
    now = Date.parse(REQUEST_ERASE_AT) + 15_000;
    await service.onFetch({ ...onFetchBody(d!.fetchRequestId!, d!.consentArtefactId), consent: { status: "REVOKED", consentDetail: null, signature: "" } }, headers("fd"));
    assert.equal(c!.status, "EXPIRED");
    assert.equal(new Date(c!.statusAt).toISOString(), REQUEST_ERASE_AT);
    assert.equal(d!.status, "EXPIRED", "it had lapsed too, at the same delete-by time");
    assert.equal(secondRow.status, "EXPIRED");
    assert.equal(new Date(secondRow.statusAt).toISOString(), REQUEST_ERASE_AT);
});

test("a GRANTED adding facilities after another one's delete-by time, before the sweep, stores them CLOSED and fetches nothing", async () => {
    const { row, a, b } = await grantedTwo();
    const fetches = pathsCalled().filter((path) => path === "fetch").length;
    now = Date.parse(GRANTED_ERASE_AT) + 15_000;
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B, ARTEFACT_C], "late-grant");

    const c = artefacts.find((artefact) => artefact.consentArtefactId === ARTEFACT_C)!;
    assert.equal(a.status, "EXPIRED");
    assert.equal(new Date(a.statusAt).toISOString(), GRANTED_ERASE_AT);
    assert.equal(b.status, "CLOSED");
    assert.equal(c.status, "CLOSED");
    assert.ok(c.recordsPurgedAt, "nothing can be received under it");
    assert.equal(row.status, "EXPIRED");
    assert.equal(new Date(row.statusAt).toISOString(), GRANTED_ERASE_AT);
    assert.equal(pathsCalled().filter((path) => path === "fetch").length, fetches, "no consent/fetch for a request that has ended");
    assert.deepEqual(calls.at(-1)!.call.body, {
        acknowledgement: [{ status: "OK", consentId: ARTEFACT_A }, { status: "OK", consentId: ARTEFACT_B }, { status: "OK", consentId: ARTEFACT_C }],
        response: { requestId: "late-grant" },
    });
    assert.deepEqual(audits.filter((event) => event.event === "ARTEFACT_CLOSED").map((event) => [event.artefactId, event.detail]), [
        [ARTEFACT_C, "granted after the request ended"],
        [ARTEFACT_B, "request ended: another provider lapsed"],
    ]);
    assert.deepEqual(lapsedAudits().map((event) => event.artefactId), [ARTEFACT_A]);
    assert.deepEqual(records, [], "the lapsed facility's records and the closed one's are deleted");

    now += 60 * 60_000;
    assert.equal(await service.retryFetches(), 0);
    assert.equal(await service.expireLapsed(), 0);
    assert.equal(await service.settleRequests(), 0);
});

test("a facility CLOSED after it had already lapsed is moved to lapsed by the sweep, and the request to EXPIRED at that time", async () => {
    const { row, a, b } = await grantedTwo();
    // As a revocation handled before this check left it: B revoked 15 s after A's delete-by time, A CLOSED with it.
    const revokedAt = new Date(Date.parse(GRANTED_ERASE_AT) + 15_000);
    Object.assign(a, { status: "CLOSED", statusAt: revokedAt, recordsPurgedAt: revokedAt });
    Object.assign(b, { status: "REVOKED", statusAt: revokedAt, recordsPurgedAt: revokedAt });
    Object.assign(row, { status: "REVOKED", statusAt: revokedAt });
    records = [];

    now = revokedAt.getTime() + 60_000;
    assert.equal(await service.expireLapsed(), 0, "nothing is still granted");
    assert.equal(await service.settleRequests(), 1);
    assert.equal(a.status, "EXPIRED");
    assert.equal(new Date(a.statusAt).toISOString(), GRANTED_ERASE_AT);
    assert.equal(b.status, "REVOKED");
    assert.equal(row.status, "EXPIRED");
    assert.equal(new Date(row.statusAt).toISOString(), GRANTED_ERASE_AT, "re-settled to when it lapsed");
    assert.deepEqual(lapsedAudits().map((event) => [event.artefactId, event.detail]), [[ARTEFACT_A, "at its delete-by time, by ClinicX; it had been closed after that"]]);
    assert.ok(!audits.some((event) => event.event === "RECORD_PURGED"), "its records went when it was closed");
    assert.ok(!audits.some((event) => /expired/i.test(String(event.detail ?? ""))));
    assert.equal(await service.settleRequests(), 0, "settled once");
});

test("a facility stored CLOSED because it was granted after its request ended is never taken as lapsed", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A]);
    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_A), ARTEFACT_A, { dataEraseAt: "2027-01-31T00:00:00.000Z" }), headers("fa"));
    const revokedAt = now;
    await notify("REVOKED", [ARTEFACT_A], "revoke-a", null);
    // Another facility's grant long after the request's own delete-by time: stored CLOSED then.
    now = Date.parse(REQUEST_ERASE_AT) + 60 * 60_000;
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B], "late-grant");
    const b = artefacts.find((artefact) => artefact.consentArtefactId === ARTEFACT_B)!;
    assert.equal(b.status, "CLOSED");

    assert.equal(await service.expireLapsed(), 0);
    assert.equal(await service.settleRequests(), 0);
    assert.equal(b.status, "CLOSED", "it was never open, so it never lapsed");
    assert.equal(row.status, "REVOKED");
    assert.equal(new Date(row.statusAt).getTime(), revokedAt);
    assert.equal(lapsedAudits().length, 0);
});

test("the sweep puts back a request that does not read how it ended first", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    const [a, b] = artefacts;
    // As a revocation that lost a race with the sweep left it: A lapsed, B revoked 20 s later, and
    // the revocation's stale write left the request REVOKED since then.
    const lapsedAt = new Date(GRANTED_ERASE_AT);
    const revokedAt = new Date(lapsedAt.getTime() + 20_000);
    Object.assign(a!, { status: "EXPIRED", statusAt: lapsedAt, recordsPurgedAt: lapsedAt });
    Object.assign(b!, { status: "REVOKED", statusAt: revokedAt, recordsPurgedAt: revokedAt });
    Object.assign(row, { status: "REVOKED", statusAt: revokedAt });
    now = revokedAt.getTime() + 60_000;
    assert.equal(await service.settleRequests(), 1);
    assert.equal(row.status, "EXPIRED");
    assert.equal(new Date(row.statusAt).toISOString(), GRANTED_ERASE_AT);
    assert.equal(await service.settleRequests(), 0);

    // The right status since a later time is put back too: REVOKED since the first revocation.
    const firstAt = new Date(now);
    Object.assign(a!, { status: "REVOKED", statusAt: firstAt });
    Object.assign(b!, { status: "REVOKED", statusAt: new Date(now + 30_000) });
    Object.assign(row, { status: "REVOKED", statusAt: new Date(now + 30_000) });
    now += 60_000;
    assert.equal(await service.settleRequests(), 1);
    assert.equal(row.status, "REVOKED");
    assert.equal(new Date(row.statusAt).getTime(), firstAt.getTime());
    assert.equal(await service.settleRequests(), 0);

    // A revocation at the same moment as a lapse counts as the revocation.
    Object.assign(a!, { status: "EXPIRED", statusAt: firstAt });
    Object.assign(b!, { status: "REVOKED", statusAt: firstAt });
    Object.assign(row, { status: "EXPIRED", statusAt: firstAt });
    assert.equal(await service.settleRequests(), 1);
    assert.equal(row.status, "REVOKED");
    assert.equal(new Date(row.statusAt).getTime(), firstAt.getTime());
    assert.equal(await service.settleRequests(), 0);
    assert.ok(!audits.some((event) => event.event === "ARTEFACT_CLOSED"), "nothing was open to close");
});

test("a request ABDM ended before any facility was stored keeps that ending, and is not picked by every sweep", async () => {
    const row = await raised();
    await notify("EXPIRED", [], "expire-all");
    const endedAt = now;
    assert.equal(row.status, "EXPIRED");
    now += 60_000;
    await notify("GRANTED", [ARTEFACT_A], "late-grant");
    now += 60_000;
    await notify("REVOKED", [ARTEFACT_A], "revoke-a", null);
    assert.equal(artefacts[0]!.status, "REVOKED", "the closed facility takes ABDM's word");
    assert.equal(row.status, "EXPIRED");
    assert.equal(new Date(row.statusAt).getTime(), endedAt);
    assert.equal(await service.settleRequests(), 0);
});

test("settle reads the artefacts again when one it would close was ended meanwhile, and writes how the request ended first", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B, ARTEFACT_C]);
    const [a, b, c] = artefacts;
    // Another handler revoked A a moment earlier: its end of A and its status write commit after this
    // revocation of B has read the artefacts, just before it would close A.
    const earlier = new Date(now - 5_000);
    let fired = false;
    beforeEnd = (id, status) => {
        if (fired || id !== a!.id || status !== "CLOSED") return;
        fired = true;
        Object.assign(a!, { status: "REVOKED", statusAt: earlier });
        Object.assign(row, { status: "REVOKED", statusAt: earlier });
    };
    await notify("REVOKED", [ARTEFACT_B], "revoke-b", null);
    assert.ok(fired);
    assert.equal(a!.status, "REVOKED", "the other handler's ending stands");
    assert.equal(b!.status, "REVOKED");
    assert.equal(c!.status, "CLOSED");
    assert.equal(row.status, "REVOKED");
    assert.equal(new Date(row.statusAt).getTime(), earlier.getTime(), "since the first revocation, not this later one");
    assert.deepEqual(audits.filter((event) => event.event === "ARTEFACT_CLOSED").map((event) => event.artefactId), [ARTEFACT_C]);
    assert.equal(await service.settleRequests(), 0);
});

test("the sweep running in the middle of a revocation's handling still leaves the request how it ended first", async () => {
    const { row, a, b } = await grantedTwo();
    now = Date.parse(GRANTED_ERASE_AT) + 20_000;
    // The whole sweep commits between this revocation's read of A and its own end of A.
    let fired = false;
    beforeEnd = async (id) => {
        if (fired || id !== a.id) return;
        fired = true;
        await service.expireLapsed();
    };
    await notify("REVOKED", [ARTEFACT_B], "revoke-b", null);
    assert.ok(fired);
    assert.equal(a.status, "EXPIRED");
    assert.equal(new Date(a.statusAt).toISOString(), GRANTED_ERASE_AT);
    assert.equal(b.status, "REVOKED", "ABDM's word on the facility it named");
    assert.equal(row.status, "EXPIRED");
    assert.equal(new Date(row.statusAt).toISOString(), GRANTED_ERASE_AT);
    assert.equal(lapsedAudits().length, 1, "lapsed once, by the sweep");
    assert.deepEqual(records, []);
    assert.equal(await service.expireLapsed(), 0);
    assert.equal(await service.settleRequests(), 0);
});

test("an artefact whose request row is gone is just ended; one with no delete-by time at all is left alone", async () => {
    const orphan = (id: number, consentArtefactId: string, dataEraseAt: Date | null): ArtefactWithTransfer => ({
        id, consentArtefactId, consentRequestFk: 999, hospitalId: 19, hipId: null, hipName: null, status: "GRANTED", statusAt: new Date(now - 86_400_000),
        hiTypes: null, dateFrom: null, dateTo: null, dataEraseAt, accessMode: null, fetchRequestId: null, fetchedAt: dataEraseAt, recordsPurgedAt: null,
        transfer: null, recordCount: 0,
    });
    artefacts.push(orphan(900, "orphan-1", new Date(now - 60_000)), orphan(901, "orphan-2", null));
    records.push({ artefactFk: 900 });

    assert.equal(await service.expireLapsed(), 1);
    assert.equal(artefacts[0]!.status, "EXPIRED");
    assert.equal(new Date(artefacts[0]!.statusAt).getTime(), now - 60_000);
    assert.equal(artefacts[1]!.status, "GRANTED");
    assert.deepEqual(records, []);
    assert.deepEqual(lapsedAudits().map((event) => [event.hospitalId, event.consentRequestId, event.artefactId]), [[19, null, "orphan-1"]]);
    assert.deepEqual(audits.filter((event) => event.event === "RECORD_PURGED").map((event) => [event.artefactId, event.detail]), [["orphan-1", "LAPSED: 1 records"]]);
});

test("a request granted with no artefacts lapses at its delete-by time; a REQUESTED one past it is left to ABDM", async () => {
    const granted = await raised();
    granted.status = "GRANTED";
    const waiting = await service.create(ctx, input({ purposeCode: "PUBHLTH" }));
    const waitingRow = requests.find((row) => row.id === waiting.id)!;
    await service.onInit({ consentRequest: { id: "dddddddd-0000-4000-8000-00000000000d" }, error: null, response: { requestId: waitingRow.initRequestId } }, headers("cb-init-2"));
    assert.equal(waitingRow.status, "REQUESTED");
    const callsBefore = calls.length;

    now = Date.parse(REQUEST_ERASE_AT) + 60_000;
    assert.equal(await service.expireLapsed(), 1);
    assert.equal(granted.status, "EXPIRED");
    assert.equal(new Date(granted.statusAt).toISOString(), REQUEST_ERASE_AT);
    assert.equal(waitingRow.status, "REQUESTED", "ABDM ends a request the patient never answered");
    assert.equal(calls.length, callsBefore);
    assert.deepEqual(lapsedAudits().map((event) => [event.hospitalId, event.consentRequestId, event.artefactId ?? null, event.detail]), [
        [19, CONSENT_REQUEST, null, "at its delete-by time, by ClinicX; no artefacts"],
    ]);
    assert.equal(await service.expireLapsed(), 0);
});

test("a legacy PARTLY_REVOKED request is settled by the sweep: REVOKED since the revocation, its other facilities CLOSED and their records deleted", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B, "dddddddd-0000-4000-8000-00000000000d"]);
    const [a, b, c] = artefacts;
    // As an earlier version left it: A revoked, B and C still granted and readable.
    const revokedAt = new Date(now + 60_000);
    Object.assign(a!, { status: "REVOKED", statusAt: revokedAt, recordsPurgedAt: revokedAt });
    Object.assign(row, { status: "PARTLY_REVOKED", statusAt: revokedAt });
    records.push({ artefactFk: b!.id }, { artefactFk: b!.id }, { artefactFk: c!.id });
    // It still loads as it is until then.
    assert.equal((await service.list(ctx, { page: 1, pageSize: 20 })).items[0]!.status, "PARTLY_REVOKED");

    now += 60 * 60_000;
    assert.equal(await service.settleRequests(), 1);
    assert.equal(row.status, "REVOKED");
    assert.equal(new Date(row.statusAt).getTime(), revokedAt.getTime());
    assert.deepEqual([a!.status, b!.status, c!.status], ["REVOKED", "CLOSED", "CLOSED"]);
    assert.deepEqual(records, []);
    assert.ok(b!.recordsPurgedAt && c!.recordsPurgedAt);
    assert.equal(audits.filter((event) => event.event === "ARTEFACT_CLOSED").length, 2);
    assert.deepEqual(audits.filter((event) => event.event === "RECORD_PURGED").map((event) => event.detail), ["CLOSED: 2 records", "CLOSED: 1 records"]);
    assert.equal(pathsCalled().filter((path) => path === "request/hiu/on-notify").length, 1, "ABDM is told nothing of it");

    assert.equal(await service.settleRequests(), 0, "nothing left to settle");
});

test("the sweep corrects a GRANTED request with a facility revoked, and an ended one with a facility still open", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A, ARTEFACT_B]);
    const [a, b] = artefacts;
    // A handler that stopped part way: A revoked, the request still GRANTED.
    Object.assign(a!, { status: "REVOKED", statusAt: new Date(now) });
    const revokedAt = now;
    now += 60_000;
    assert.equal(await service.settleRequests(), 1);
    assert.equal(row.status, "REVOKED");
    assert.equal(new Date(row.statusAt).getTime(), revokedAt);
    assert.equal(b!.status, "CLOSED");

    // REVOKED already, with a facility left GRANTED: it is closed, the request's time kept.
    Object.assign(b!, { status: "GRANTED" });
    now += 60_000;
    assert.equal(await service.settleRequests(), 1);
    assert.equal(b!.status, "CLOSED");
    assert.equal(row.status, "REVOKED");
    assert.equal(new Date(row.statusAt).getTime(), revokedAt);
    assert.equal(await service.settleRequests(), 0);
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

test("a grant without its terms yet waits for them when it came after its request's delete-by time; only spent fetches fall back", () => {
    const row = { dataEraseAt: new Date(REQUEST_ERASE_AT) };
    const before = new Date(Date.parse(REQUEST_ERASE_AT) - 60_000);
    const after = new Date(Date.parse(REQUEST_ERASE_AT) + 60_000);
    assert.equal(deleteByOf({ dataEraseAt: new Date(LATER_ERASE_AT), createdAt: after }, row)?.toISOString(), new Date(LATER_ERASE_AT).toISOString(), "its granted time always wins");
    assert.equal(deleteByOf({ dataEraseAt: null, createdAt: before }, row)?.toISOString(), REQUEST_ERASE_AT, "open at the request's time: that time");
    assert.equal(deleteByOf({ dataEraseAt: null, createdAt: after, fetchAttempts: 1 }, row), null, "the patient may have granted longer: wait for on-fetch");
    assert.equal(deleteByOf({ dataEraseAt: null, createdAt: after, fetchAttempts: 4 }, row)?.toISOString(), REQUEST_ERASE_AT, "fetches spent: it cannot stay open for ever");
    assert.equal(deleteByOf({ dataEraseAt: null }, row)?.toISOString(), REQUEST_ERASE_AT, "when it was stored is unknown: as before");
    assert.equal(deleteByOf({ dataEraseAt: null, createdAt: after }, null), null);
});

test("a grant that arrives after the requested delete-by time is fetched, not lapsed on arrival, and lasts to its own granted time", async () => {
    const row = await raised();
    now = Date.parse(REQUEST_ERASE_AT) + 60_000;
    await notify("GRANTED", [ARTEFACT_A]);
    const [a] = artefacts;
    assert.equal(a!.status, "GRANTED");
    assert.equal(row.status, "GRANTED");
    assert.ok(fetchRequestIdOf(ARTEFACT_A), "its consent/fetch went out");
    assert.equal(lapsedAudits().length, 0);
    assert.equal(await service.expireLapsed(), 0, "nothing to go by until its terms arrive");

    const grantedUntil = "2027-01-31T00:00:00.000Z";
    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_A), ARTEFACT_A, { dataEraseAt: grantedUntil }), headers("fa"));
    assert.equal(await service.expireLapsed(), 0);
    assert.equal(row.status, "GRANTED");
    now = Date.parse(grantedUntil) + 1_000;
    assert.equal(await service.expireLapsed(), 1);
    assert.equal(a!.status, "EXPIRED");
    assert.equal(new Date(a!.statusAt).toISOString(), grantedUntil);
    assert.equal(row.status, "EXPIRED");
});

test("a second grant after the requested delete-by time never closes a facility still inside its own granted time", async () => {
    const row = await raised();
    await notify("GRANTED", [ARTEFACT_A]);
    const grantedUntil = "2027-03-31T00:00:00.000Z";
    await service.onFetch(onFetchBody(fetchRequestIdOf(ARTEFACT_A), ARTEFACT_A, { dataEraseAt: grantedUntil }), headers("fa"));
    const a = artefacts.find((x) => x.consentArtefactId === ARTEFACT_A)!;
    records.push({ artefactFk: a.id });

    now = Date.parse(REQUEST_ERASE_AT) + 60_000;
    await notify("GRANTED", [ARTEFACT_B], "notify-granted-b");
    const b = artefacts.find((x) => x.consentArtefactId === ARTEFACT_B)!;
    assert.equal(a.status, "GRANTED");
    assert.equal(b.status, "GRANTED", "waits for its own terms");
    assert.equal(row.status, "GRANTED");
    assert.equal(records.length, 1, "A's record stays");
    assert.ok(!audits.some((event) => event.event === "ARTEFACT_CLOSED" || event.event === "CONSENT_LAPSED"));
    assert.equal(await service.expireLapsed(), 0);
});
