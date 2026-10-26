import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AbdmCall } from "./abdm-gateway.service.js";
import { AbhaJourneyError } from "./abha-enrolment.service.js";
import { AbhaShareService, counterShareUrl, type AbhaShareStore, type SharedPatient, type ShareRow } from "./abha-share.service.js";

const ABHA_NUMBER = "91-1111-2222-3333";
const EXISTING = "22222222-2222-2222-2222-222222222222";

const shareBody = (overrides: Record<string, any> = {}) => ({
    intent: "PROFILE_SHARE",
    metaData: { hipId: "Yira-HIP", context: "OPD1", hprId: null, latitude: null, longitude: null },
    profile: {
        patient: {
            abhaNumber: ABHA_NUMBER,
            abhaAddress: "asha.kumari@sbx",
            name: "Asha  Kumari",
            gender: "F",
            dayOfBirth: "5",
            monthOfBirth: "8",
            yearOfBirth: "1990",
            phoneNumber: "+91-9876540903",
            address: { line: "12 MG Road", district: "Pune", state: "Maharashtra", pincode: "411001" },
            ...overrides,
        },
    },
});

let now: number;
let rows: ShareRow[];
let onShares: any[];
let created: SharedPatient[];
let updated: string[];
let byAbha: Map<string, string>;
let byAddress: Map<string, string[]>;
let demographicMatches: string[];
/** Set to make createShare fail, as the database would. */
let createShareFault: ((row: Omit<ShareRow, "id" | "createdAt">) => void) | null;
let failNextOnShare: boolean;
let service: AbhaShareService;
let createFails: boolean;

/** Counter ids compare without case, as the database's collation does. */
const sameCounter = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

const store: AbhaShareStore = {
    async findShareByRequestId(requestId) { return rows.find((row) => row.requestId === requestId) ?? null; },
    async createShare(row) {
        createShareFault?.(row);
        const id = rows.length + 1;
        rows.push({ ...row, id, createdAt: new Date(now) });
        return id;
    },
    async updateShare(id, changes) { Object.assign(rows.find((row) => row.id === id)!, changes); },
    async findActiveShare({ userId, hospitalId, counterId, now: at }) {
        return [...rows].reverse().find((row) => row.userId === userId && row.hospitalId === hospitalId && sameCounter(row.counterId, counterId)
            && row.tokenNumber && row.expiresAt && row.expiresAt > at && ["REGISTERED", "ACKNOWLEDGED"].includes(row.status)) ?? null;
    },
    async maxTokenToday({ hospitalId, counterId }) {
        const max = Math.max(0, ...rows.filter((row) => row.hospitalId === hospitalId && sameCounter(row.counterId, counterId)).map((row) => Number(row.tokenNumber) || 0));
        // A database round trip: another share can run its own read before this one's token is written.
        await new Promise((resolve) => setImmediate(resolve));
        return max;
    },
    async listShares({ counterId }) {
        return [...rows].reverse().filter((row) => row.status !== "REPEAT" && (!counterId || sameCounter(row.counterId, counterId)));
    },
    async findPatientIdByAbhaNumber(abhaNumber) { return byAbha.get(abhaNumber) ?? null; },
    async findPatientIdsByAbhaAddress(patient) { return byAddress.get(patient.abhaAddress) ?? []; },
    async findPatientIdsByDemographics() { return demographicMatches; },
    async createPatient(patient) {
        if (createFails) throw new Error("the database refused the new patient");
        created.push(patient);
        const id = `new-${created.length}`;
        if (patient.abhaNumber) byAbha.set(patient.abhaNumber, id);
        byAddress.set(patient.abhaAddress, [id]);
        return id;
    },
    async updatePatientAbha(userId) { updated.push(userId); },
};

const gateway = {
    async call<T>(call: AbdmCall): Promise<T> {
        assert.equal(call.host, "gateway");
        assert.equal(call.path, "/api/hiecm/patient-share/v3/on-share");
        if (failNextOnShare) {
            failNextOnShare = false;
            throw new Error("The gateway refused the on-share");
        }
        onShares.push(call.body);
        return {} as T;
    },
};

beforeEach(() => {
    process.env.ABDM_SHARE_TOKEN_EXPIRY = "60";
    delete process.env.ABDM_SHARE_EXPIRY_UNIT;
    createFails = false;
    now = new Date(2026, 9, 26, 10, 0, 0).getTime();
    rows = [];
    onShares = [];
    created = [];
    updated = [];
    byAbha = new Map();
    byAddress = new Map();
    demographicMatches = [];
    createShareFault = null;
    failNextOnShare = false;
    // Yira Hospitals (19) runs Scan and Share as Yira-HIP
    service = new AbhaShareService(store, gateway, () => now, {
        byScanShareHipId: async (id) => (id === "Yira-HIP" ? { hospitalId: 19, hipId: null, name: "Yira.ai", scanShareHipId: "Yira-HIP", autoLink: false } : null),
    });
});

const share = async (requestId: string, overrides: Record<string, any> = {}, context = "OPD1") => {
    const body = shareBody(overrides);
    body.metaData.context = context;
    await service.process(requestId, await service.parse("Yira-HIP", body));
};

test("the share is read into the clinic's own shapes", async () => {
    const parsed = await service.parse("Yira-HIP", shareBody());
    assert.equal(parsed.hospitalId, 19, "the hospital whose counter QR carries that HIP id");
    assert.equal(parsed.counterId, "OPD1");
    assert.deepEqual(parsed.patient, {
        abhaNumber: ABHA_NUMBER,
        abhaAddress: "asha.kumari@sbx",
        name: "Asha Kumari",
        firstName: "Asha",
        lastName: "Kumari",
        gender: "Female",
        dateOfBirth: "1990-08-05",
        yearOfBirth: "1990",
        phone: "9876540903",
        address: { line: "12 MG Road", district: "Pune", state: "Maharashtra", pincode: "411001" },
    });
});

test("the shared ABHA number is kept in the dashed form, and one that is not 14 digits is dropped", async () => {
    const abhaNumberOf = async (abhaNumber: unknown) => (await service.parse("Yira-HIP", shareBody({ abhaNumber }))).patient.abhaNumber;
    assert.equal(await abhaNumberOf("91111122223333"), ABHA_NUMBER);
    assert.equal(await abhaNumberOf("91 1111 2222 3333"), ABHA_NUMBER);
    assert.equal(await abhaNumberOf(ABHA_NUMBER), ABHA_NUMBER);
    assert.equal(await abhaNumberOf("9111112222333"), null);
    assert.equal(await abhaNumberOf(null), null);
});

test("a share for another HIP, without a counter, or without a name is refused before it is answered", async () => {
    const refuse = (hip: string, body: any, status: number) =>
        assert.rejects(service.parse(hip, body), (error: unknown) => error instanceof AbhaJourneyError && error.status === status);
    await refuse("Other-HIP", { ...shareBody(), metaData: { hipId: "Other-HIP", context: "OPD1" } }, 403);
    await refuse("Other-HIP", shareBody(), 403);
    await refuse("Yira-HIP", { ...shareBody(), metaData: { hipId: "Yira-HIP" } }, 400);
    await refuse("Yira-HIP", shareBody({ name: "" }), 400);
    await refuse("Yira-HIP", { ...shareBody(), intent: "RECORD_SHARE" }, 400);
    await refuse("Yira-HIP", { ...shareBody(), metaData: { hipId: "Yira-HIP", context: "C".repeat(21) } }, 400);
    assert.equal((await service.parse("Yira-HIP", { ...shareBody(), metaData: { hipId: "Yira-HIP", context: "C".repeat(20) } })).counterId, "C".repeat(20));
});

test("a first scan registers a new patient with nothing typed and answers with token 1 (701)", async () => {
    await share("req-1");

    assert.equal(created.length, 1);
    assert.equal(rows[0]!.matchType, "NEW");
    assert.equal(rows[0]!.status, "ACKNOWLEDGED");
    assert.deepEqual(onShares[0], {
        acknowledgement: {
            status: "SUCCESS",
            abhaAddress: "asha.kumari@sbx",
            profile: { context: "OPD1", tokenNumber: "1", expiry: 60 },
        },
        response: { requestId: "req-1" },
    });
});

test("ABDM retrying the same share is not processed twice", async () => {
    await share("req-1");
    await share("req-1");
    assert.equal(created.length, 1);
    assert.equal(onShares.length, 1);
});

test("a returning patient is matched on the ABHA number and keeps one record (702)", async () => {
    byAbha.set(ABHA_NUMBER, EXISTING);
    await share("req-1", { abhaAddress: "asha.second@sbx" });
    assert.equal(created.length, 0);
    assert.deepEqual(updated, [EXISTING], "the new ABHA address is recorded on the same patient");
    assert.equal(rows[0]!.matchType, "ABHA_NUMBER");
    assert.equal(onShares[0].acknowledgement.abhaAddress, "asha.second@sbx");
});

test("a returning patient linked at the desk is matched when ABDM sends the ABHA number without dashes (702)", async () => {
    byAbha.set(ABHA_NUMBER, EXISTING);
    await share("req-1", { abhaNumber: "91111122223333" });
    assert.equal(created.length, 0, "no second record for the same ABHA number");
    assert.equal(rows[0]!.matchType, "ABHA_NUMBER");
    assert.equal(rows[0]!.abhaNumber, ABHA_NUMBER);
});

test("a patient whose record holds the shared ABHA address is matched on it before name and mobile (702)", async () => {
    byAddress.set("asha.kumari@sbx", [EXISTING]);
    await share("req-1", { abhaNumber: null, name: "Asha K" });
    assert.equal(created.length, 0);
    assert.deepEqual(updated, [EXISTING]);
    assert.equal(rows[0]!.matchType, "ABHA_ADDRESS");

    byAddress.set("asha.kumari@sbx", [EXISTING, "33333333-3333-3333-3333-333333333333"]);
    await share("req-2", { abhaNumber: null }, "OPD2");
    assert.equal(created.length, 0, "two records holding one address are left for the desk");
    assert.equal(rows[1]!.matchType, "AMBIGUOUS");
});

test("a repeat scan at the same counter keeps the token and adds no queue entry; another counter gets its own (702)", async () => {
    const firstExpiry = now + 60 * 60_000;
    await share("req-1");
    now += 5 * 60_000;
    await share("req-2");
    assert.equal(rows[1]!.status, "REPEAT");
    assert.deepEqual((await service.queue({ hospitalId: 19, counterId: "OPD1" })).map((row) => row.requestId), ["req-1"], "one queue entry for the person");
    assert.deepEqual(onShares[1].acknowledgement.profile, { context: "OPD1", tokenNumber: "1", expiry: 55 }, "the same token, with the time it has left");
    assert.equal(rows[0]!.status, "ACKNOWLEDGED", "the existing entry is unchanged");
    assert.equal(rows[0]!.expiresAt!.getTime(), firstExpiry);

    await share("req-3", {}, "OPD2");
    assert.equal(rows[2]!.tokenNumber, "1", "the other counter starts its own queue");
    assert.equal(onShares[2].acknowledgement.profile.context, "OPD2");
    assert.equal((await service.queue({ hospitalId: 19 })).length, 2);

    now += 56 * 60_000;
    await share("req-4");
    assert.equal(rows[3]!.tokenNumber, "2", "after the token runs out the patient queues again");
    assert.equal(rows[3]!.status, "ACKNOWLEDGED");
});

test("the on-share expiry is sent in the unit ABDM_SHARE_EXPIRY_UNIT names; the token stays valid for the minutes configured", async () => {
    process.env.ABDM_SHARE_EXPIRY_UNIT = "seconds";
    await share("req-1");
    assert.equal(onShares[0].acknowledgement.profile.expiry, 3600);
    assert.equal(rows[0]!.expiresAt!.getTime(), now + 60 * 60_000);

    now += 59 * 60_000 + 59_500;
    await share("req-2");
    assert.equal(onShares[1].acknowledgement.profile.tokenNumber, "1");
    assert.equal(onShares[1].acknowledgement.profile.expiry, 1, "never below 1");
});

test("two patients scanning one counter together get tokens 1 and 2", async () => {
    await Promise.all([
        share("req-1"),
        share("req-2", { abhaNumber: "91-4444-5555-6666", abhaAddress: "ravi.kumar@sbx", name: "Ravi Kumar", gender: "M" }),
    ]);
    assert.equal(created.length, 2);
    assert.deepEqual(rows.map((row) => row.tokenNumber).sort(), ["1", "2"]);
    assert.deepEqual(onShares.map((body) => body.acknowledgement.profile.tokenNumber).sort(), ["1", "2"]);
});

test("one counter's QR codes that differ only in case still give two patients scanning together tokens 1 and 2", async () => {
    await Promise.all([
        share("req-1", {}, "OPD1"),
        share("req-2", { abhaNumber: "91-4444-5555-6666", abhaAddress: "ravi.kumar@sbx", name: "Ravi Kumar", gender: "M" }, "opd1"),
    ]);
    assert.deepEqual(rows.map((row) => row.tokenNumber).sort(), ["1", "2"]);
});

test("an uncertain demographic match registers nobody and is left for the desk", async () => {
    byAbha.clear();
    demographicMatches = [EXISTING, "33333333-3333-3333-3333-333333333333"];
    await share("req-1", { abhaNumber: null });
    assert.equal(created.length, 0);
    assert.equal(rows[0]!.matchType, "AMBIGUOUS");
    assert.equal(rows[0]!.status, "REVIEW");
    assert.equal(onShares[0].acknowledgement.status, "SUCCESS", "the patient still gets a token");
});

test("a share the facility cannot register is answered with the error alone, not left waiting", async () => {
    createFails = true;
    await share("req-1");
    assert.equal(rows[0]!.status, "FAILED");
    assert.deepEqual(onShares[0], {
        error: { code: "ABDM-9999", message: "The facility could not register this share. Please ask at the counter." },
        response: { requestId: "req-1" },
    });
});

test("a share that cannot even be recorded is still answered with an error", async () => {
    createShareFault = () => { throw new Error("String or binary data would be truncated"); };
    await share("req-1");
    assert.equal(rows.length, 0);
    assert.equal(onShares.length, 1);
    assert.equal(onShares[0].error.code, "ABDM-9999");
    assert.equal(onShares[0].response.requestId, "req-1");
});

test("a repeat scan whose answer fails still adds no queue entry", async () => {
    await share("req-1");
    failNextOnShare = true;
    await share("req-2");
    assert.equal(rows[1]!.status, "REPEAT");
    assert.ok(rows[1]!.error);
    assert.equal((await service.queue({ hospitalId: 19, counterId: "OPD1" })).length, 1);
    assert.equal(onShares[1].error.code, "ABDM-9999", "the patient is told it failed");
});

test("a duplicate delivery that loses the REQUEST-ID to a concurrent one is not answered twice", async () => {
    createShareFault = (row) => {
        rows.push({ ...row, id: 99, createdAt: new Date(now) });
        throw new Error("Violation of UNIQUE KEY constraint UX_AbhaProfileShares_RequestId");
    };
    await share("req-1");
    assert.equal(onShares.length, 0);
    assert.equal(created.length, 0);
});

test("the counter QR code opens the PHR share page for this HIP and counter", () => {
    assert.equal(counterShareUrl("Yira-HIP", "OPD1"), "https://phrsbx.abdm.gov.in/share-profile?hip-id=Yira-HIP&counter-id=OPD1");
});
