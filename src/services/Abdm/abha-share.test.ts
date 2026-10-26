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
let demographicMatches: string[];
let service: AbhaShareService;

const store: AbhaShareStore = {
    async findShareByRequestId(requestId) { return rows.find((row) => row.requestId === requestId) ?? null; },
    async createShare(row) {
        const id = rows.length + 1;
        rows.push({ ...row, id, createdAt: new Date(now) });
        return id;
    },
    async updateShare(id, changes) { Object.assign(rows.find((row) => row.id === id)!, changes); },
    async findActiveShare({ userId, hospitalId, counterId, now: at }) {
        return [...rows].reverse().find((row) => row.userId === userId && row.hospitalId === hospitalId && row.counterId === counterId
            && row.tokenNumber && row.expiresAt && row.expiresAt > at && ["REGISTERED", "ACKNOWLEDGED"].includes(row.status)) ?? null;
    },
    async maxTokenToday({ hospitalId, counterId }) {
        return Math.max(0, ...rows.filter((row) => row.hospitalId === hospitalId && row.counterId === counterId).map((row) => Number(row.tokenNumber) || 0));
    },
    async listShares() { return rows; },
    async findPatientIdByAbhaNumber(abhaNumber) { return byAbha.get(abhaNumber) ?? null; },
    async findPatientIdsByDemographics() { return demographicMatches; },
    async createPatient(patient) {
        created.push(patient);
        const id = `new-${created.length}`;
        if (patient.abhaNumber) byAbha.set(patient.abhaNumber, id);
        return id;
    },
    async updatePatientAbha(userId) { updated.push(userId); },
};

const gateway = {
    async call<T>(call: AbdmCall): Promise<T> {
        assert.equal(call.host, "gateway");
        assert.equal(call.path, "/api/hiecm/patient-share/v3/on-share");
        onShares.push(call.body);
        return {} as T;
    },
};

beforeEach(() => {
    process.env.ABDM_HIP_ID = "Yira-HIP";
    process.env.ABDM_HIP_HOSPITAL_ID = "19";
    process.env.ABDM_SHARE_TOKEN_EXPIRY = "60";
    now = new Date(2026, 9, 26, 10, 0, 0).getTime();
    rows = [];
    onShares = [];
    created = [];
    updated = [];
    byAbha = new Map();
    demographicMatches = [];
    service = new AbhaShareService(store, gateway, () => now);
});

const share = async (requestId: string, overrides: Record<string, any> = {}, context = "OPD1") => {
    const body = shareBody(overrides);
    body.metaData.context = context;
    await service.process(requestId, service.parse("Yira-HIP", body));
};

test("the share is read into the clinic's own shapes", () => {
    const parsed = service.parse("Yira-HIP", shareBody());
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

test("a share for another HIP, without a counter, or without a name is refused before it is answered", () => {
    const refuse = (hip: string, body: any, status: number) =>
        assert.throws(() => service.parse(hip, body), (error: unknown) => error instanceof AbhaJourneyError && error.status === status);
    refuse("Other-HIP", { ...shareBody(), metaData: { hipId: "Other-HIP", context: "OPD1" } }, 403);
    refuse("Other-HIP", shareBody(), 403);
    refuse("Yira-HIP", { ...shareBody(), metaData: { hipId: "Yira-HIP" } }, 400);
    refuse("Yira-HIP", shareBody({ name: "" }), 400);
    refuse("Yira-HIP", { ...shareBody(), intent: "RECORD_SHARE" }, 400);
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

test("the same counter while the token is valid keeps the token; another counter gets its own (702)", async () => {
    await share("req-1");
    await share("req-2");
    assert.equal(rows[1]!.tokenNumber, "1", "no new queue entry at the same counter");

    await share("req-3", {}, "OPD2");
    assert.equal(rows[2]!.tokenNumber, "1", "the other counter starts its own queue");
    assert.equal(onShares[2].acknowledgement.profile.context, "OPD2");

    now += 61 * 60_000;
    await share("req-4");
    assert.equal(rows[3]!.tokenNumber, "2", "after the token runs out the patient queues again");
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

test("a share the facility cannot register is answered with an error, not left waiting", async () => {
    delete process.env.ABDM_HIP_HOSPITAL_ID;
    await share("req-1");
    assert.equal(rows[0]!.status, "FAILED");
    assert.equal(onShares[0].response.requestId, "req-1");
    assert.equal(onShares[0].error.code, "ABDM-9999");
});

test("the counter QR code opens the PHR share page for this HIP and counter", () => {
    assert.equal(counterShareUrl("Yira-HIP", "OPD1"), "https://phrsbx.abdm.gov.in/share-profile?hip-id=Yira-HIP&counter-id=OPD1");
});
