import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AbdmApiError } from "../abdm-gateway.service.js";
import { CareContextCatalog, byHiType, careContextDisplay, parseCareContextReference } from "./care-contexts.js";
import { HipLinkingService, LinkingError, tokenExpiry } from "./hip-linking.js";
import { PatientLinkingService, looksLikeSamePerson } from "./patient-linking.js";
import { DataFlowService } from "./data-flow.js";
import type { CareContextRow, CareContextSeed, ConsentRow, LinkRequestRow, LinkStatePatch, M2Store, PatientProfile, TransferRow } from "./m2-store.js";
import { decrypt, generateKeyMaterial } from "../hie-crypto.js";
import { fixtureParties } from "../fhir/fhir-fixtures.js";
import { AbdmCallbackService } from "../abdm-callback.service.js";
import type { VisitRecords } from "../../../repositories/Abdm/abdm-health-record.repository.js";

const HIP = "IN3610000001";
const HOSPITAL = 12;
const PATIENT = "0f6c2b8e-1d2a-4c55-9d7e-0a1b2c3d4e5f";
const NOW = new Date("2026-10-26T10:00:00Z");

class MemoryStore implements M2Store {
    patients: PatientProfile[] = [{ userId: PATIENT, name: "Asha Rao", gender: "Female", birthDate: "1990-04-12", phone: "+919800000000", abhaNumber: "91-1234-5678-9012", abhaAddress: "asha.test@sbx" }];
    contexts: CareContextRow[] = [];
    tokens: Array<{ patientUserId: string; hipId: string; abhaAddress: string; token: string; expiresAt: Date; requestId: string }> = [];
    linkRequests: LinkRequestRow[] = [];
    consents: ConsentRow[] = [];
    transfers: TransferRow[] = [];
    appointments = [101];
    private nextId = 1;

    async patient(id: string) { return this.patients.find((p) => p.userId === id.toLowerCase()) ?? null; }
    async patientsAt(_h: number, c: { abhaAddress?: string; abhaNumber?: string; mobile?: string; userId?: string }) {
        return this.patients.filter((p) =>
            (c.abhaAddress && p.abhaAddress?.toLowerCase() === c.abhaAddress.toLowerCase())
            || (c.abhaNumber && p.abhaNumber?.replace(/\D/g, "") === c.abhaNumber.replace(/\D/g, ""))
            || (c.mobile && p.phone?.replace(/\D/g, "").slice(-10) === c.mobile.replace(/\D/g, "").slice(-10))
            || (c.userId && p.userId === c.userId.toLowerCase()));
    }
    async patientsWithAbhaAt() { return this.patients.filter((p) => p.abhaAddress).map((p) => p.userId); }
    async appointmentIds() { return this.appointments; }
    async upsertCareContexts(seeds: CareContextSeed[]) {
        for (const s of seeds) {
            const existing = this.contexts.find((c) => c.hipId === s.hipId && c.referenceNumber === s.referenceNumber);
            if (existing) Object.assign(existing, { display: s.display, hiTypes: s.hiTypes, recordDate: s.recordDate });
            else this.contexts.push({ ...s, id: this.nextId++, linkStatus: "not-linked", linkedVia: null, linkedAbhaAddress: null, linkRequestId: null, linkedAt: null, notifiedHiTypes: [], lastError: null });
        }
    }
    async careContexts(p: string, h: string) { return this.contexts.filter((c) => c.patientUserId === p && c.hipId === h).map((c) => ({ ...c })); }
    async careContextsByRefs(h: string, refs: string[]) { return this.contexts.filter((c) => c.hipId === h && refs.includes(c.referenceNumber)).map((c) => ({ ...c })); }
    async careContextsByLinkRequest(r: string) { return this.contexts.filter((c) => c.linkRequestId === r).map((c) => ({ ...c })); }
    async setLinkState(ids: number[], patch: LinkStatePatch) { for (const c of this.contexts) if (ids.includes(c.id)) Object.assign(c, patch); }
    async linkToken(p: string, h: string, after: Date) {
        const t = this.tokens.filter((x) => x.patientUserId === p && x.hipId === h && x.expiresAt > after).sort((a, b) => +b.expiresAt - +a.expiresAt)[0];
        return t ? { token: t.token, abhaAddress: t.abhaAddress, expiresAt: t.expiresAt } : null;
    }
    async saveLinkToken(row: any) { this.tokens.push(row); }
    async dropLinkTokens(p: string, h: string) { this.tokens = this.tokens.filter((t) => !(t.patientUserId === p && t.hipId === h)); }
    async createLinkRequest(row: LinkRequestRow) { this.linkRequests.push({ ...row }); }
    async linkRequest(ref: string) { const r = this.linkRequests.find((x) => x.linkRefNumber === ref); return r ? { ...r } : null; }
    async updateLinkRequest(ref: string, patch: any) { Object.assign(this.linkRequests.find((x) => x.linkRefNumber === ref)!, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))); }
    async saveConsent(row: any) {
        const existing = this.consents.find((c) => c.consentId === row.consentId);
        if (existing) Object.assign(existing, Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && !(Array.isArray(v) && !v.length))));
        else this.consents.push(row);
    }
    async consent(id: string) { return this.consents.find((c) => c.consentId === id) ?? null; }
    async createTransfer(row: TransferRow) {
        if (this.transfers.some((t) => t.transactionId === row.transactionId)) return "duplicate" as const;
        this.transfers.push({ ...row });
        return "created" as const;
    }
    async updateTransfer(id: string, patch: any) { Object.assign(this.transfers.find((t) => t.transactionId === id)!, patch); }
}

class FakeGateway {
    calls: Array<{ path: string; headers: Record<string, string>; body: any; requestId?: string }> = [];
    refuse: Record<string, AbdmApiError> = {};
    async call(c: any) {
        this.calls.push({ path: c.path, headers: c.headers ?? {}, body: c.body, requestId: c.requestId });
        const refusal = this.refuse[c.path];
        if (refusal) { delete this.refuse[c.path]; throw refusal; }
        return {};
    }
    async getAccessToken() { return "gateway-token"; }
    last(path: string) { return [...this.calls].reverse().find((c) => c.path.endsWith(path))!; }
}

const visit = (): VisitRecords => ({
    parties: fixtureParties,
    appointment: { id: 101, start: new Date("2026-10-20T10:00:00+05:30"), end: null, teleconsultation: false },
    registration: { allergies: null, medicalHistory: null },
    medicalRecords: [{ Id: "mr-1", Type: "Consultation", Date: new Date("2026-10-20T10:00:00+05:30"), ChiefComplaint: "Toothache", Diagnosis: "Dental caries" } as any],
    prescriptions: [{ row: { Id: "rx-1", Date: new Date("2026-10-20T10:10:00+05:30") } as any, medications: [{ id: "m-1", name: "Paracetamol 650 mg tablet" }], diagnoses: [], pdf: null }],
    notes: [], documents: [], bills: [], immunizations: [], certificates: new Map(),
});
const records = {
    visit: async () => visit(),
    standaloneRecordIds: async () => ({ dischargeSummaryIds: [3], immunizationIds: [], vitalsRecordIds: [] }),
    dischargeSummary: async () => ({ summary: { AdmittedAt: new Date("2026-10-10T09:00:00+05:30"), DischargedAt: new Date("2026-10-12T09:00:00+05:30") } } as any),
    immunization: async () => { throw new Error("unused"); },
    vitalsRecord: async () => { throw new Error("unused"); },
};

let store: MemoryStore;
let gateway: FakeGateway;
let catalog: CareContextCatalog;
const realConsole = { log: console.log, warn: console.warn, error: console.error };

const hip = { id: HIP, hospitalId: HOSPITAL, name: "Ocimum Dental Clinic" };

beforeEach(() => {
    store = new MemoryStore();
    gateway = new FakeGateway();
    catalog = new CareContextCatalog(store, records as any);
    for (const level of ["log", "warn", "error"] as const) console[level] = () => {};
});
afterEach(() => {
    Object.assign(console, realConsole);
});

const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;

// ---------- care contexts

test("care contexts: one per visit and per stay, referenced so they resolve back, displayed without clinical detail", async () => {
    const contexts = await catalog.refresh(hip, PATIENT);
    assert.deepEqual(contexts.map((c) => [c.referenceNumber, c.hiTypes]).sort(), [["IP-3", ["DischargeSummary"]], ["OP-101", ["OPConsultation", "Prescription"]]]);
    const op = contexts.find((c) => c.kind === "visit")!;
    assert.equal(op.display, "OPD visit, 20 Oct 2026");
    assert.ok(!/toothache|caries|paracetamol/i.test(contexts.map((c) => c.display).join(" ")), "no clinical words");
    assert.equal(contexts.find((c) => c.kind === "discharge")!.display, "Hospital stay, 10 Oct 2026 to 12 Oct 2026");
    assert.deepEqual(parseCareContextReference("VT-6b1c-uuid"), { kind: "vitals", sourceId: "6b1c-uuid" });
    assert.equal(careContextDisplay("visit", new Date("2026-01-02T10:00:00+05:30"), { teleconsultation: true }), "Teleconsultation, 02 Jan 2026");

    store.contexts[0]!.linkStatus = "linked";
    await catalog.refresh(hip, PATIENT);
    assert.equal(store.contexts[0]!.linkStatus, "linked", "a refresh keeps link state");
});

test("byHiType: one patient entry per HI type, with its care contexts and their count", () => {
    const grouped = byHiType("p-1", "Asha", [
        { referenceNumber: "OP-1", display: "a", hiTypes: ["OPConsultation", "Prescription"] },
        { referenceNumber: "OP-2", display: "b", hiTypes: ["Prescription"] },
    ]);
    assert.deepEqual(grouped.map((g) => [g.hiType, g.count, g.careContexts.map((c) => c.referenceNumber)]), [["OPConsultation", 1, ["OP-1"]], ["Prescription", 2, ["OP-1", "OP-2"]]]);
    assert.ok(grouped.every((g) => g.referenceNumber === "p-1" && g.display === "Asha"));
});

// ---------- HIP-initiated linking

test("linking without a token asks for one, links on its arrival, and marks the care contexts linked on the answer", async () => {
    const linking = new HipLinkingService(store, catalog, gateway as any, () => NOW);
    assert.deepEqual(await linking.link(hip, PATIENT), { queued: 2, status: "awaiting-token" });

    const tokenCall = gateway.last("/token/generate-token");
    assert.equal(tokenCall.headers["X-HIP-ID"], HIP);
    assert.deepEqual(tokenCall.body, { abhaNumber: 91123456789012, abhaAddress: "asha.test@sbx", name: "Asha Rao", gender: "F", yearOfBirth: 1990 });
    assert.ok(store.contexts.every((c) => c.linkStatus === "awaiting-token" && c.linkRequestId === tokenCall.requestId));

    const exp = Math.floor(NOW.getTime() / 1000) + 180 * 86400;
    await linking.onLinkToken(hip, tokenCall.requestId!, { abhaAddress: "asha.test@sbx", linkToken: jwt(exp), response: { requestId: tokenCall.requestId } });
    assert.equal(store.tokens.length, 1);
    assert.equal(store.tokens[0]!.expiresAt.getTime(), exp * 1000);

    const linkCall = gateway.last("/link/carecontext");
    assert.equal(linkCall.headers["X-LINK-TOKEN"], jwt(exp));
    assert.equal(linkCall.body.abhaAddress, "asha.test@sbx");
    assert.deepEqual(linkCall.body.patient.map((p: any) => [p.hiType, p.count]), [["OPConsultation", 1], ["Prescription", 1], ["DischargeSummary", 1]]);
    assert.ok(store.contexts.every((c) => c.linkStatus === "linking"));

    await linking.onLinkResult(linkCall.requestId!, { abhaAddress: "asha.test@sbx", status: "Successfully Linked care context", response: { requestId: linkCall.requestId } });
    assert.ok(store.contexts.every((c) => c.linkStatus === "linked" && c.linkedVia === "hip" && c.linkedAt));
    assert.deepEqual(await linking.link(hip, PATIENT), { queued: 0, status: "nothing to link" });
});

test("a valid stored token is reused: no second generate-token", async () => {
    store.tokens.push({ patientUserId: PATIENT, hipId: HIP, abhaAddress: "asha.test@sbx", token: "kept", expiresAt: new Date(NOW.getTime() + 30 * 86400_000), requestId: "r" });
    const linking = new HipLinkingService(store, catalog, gateway as any, () => NOW);
    assert.deepEqual(await linking.link(hip, PATIENT), { queued: 2, status: "linking" });
    assert.equal(gateway.calls.filter((c) => c.path.endsWith("generate-token")).length, 0);
    assert.equal(gateway.last("/link/carecontext").headers["X-LINK-TOKEN"], "kept");
});

test("a token ABDM refuses is dropped and a new one asked for", async () => {
    store.tokens.push({ patientUserId: PATIENT, hipId: HIP, abhaAddress: "asha.test@sbx", token: "stale", expiresAt: new Date(NOW.getTime() + 30 * 86400_000), requestId: "r" });
    gateway.refuse["/api/hiecm/hip/v3/link/carecontext"] = new AbdmApiError({ status: 400, kind: "rejected", operation: "x", code: "ABDM-1026", message: "Invalid Link Token" });
    const linking = new HipLinkingService(store, catalog, gateway as any, () => NOW);
    await linking.link(hip, PATIENT);
    assert.equal(store.tokens.length, 0);
    assert.ok(gateway.last("/token/generate-token"));
    assert.ok(store.contexts.every((c) => c.linkStatus === "awaiting-token"));
});

test("an error on the token callback, a missing gender, or no ABHA leave the care contexts failed with the reason", async () => {
    const linking = new HipLinkingService(store, catalog, gateway as any, () => NOW);
    await linking.link(hip, PATIENT);
    const tokenCall = gateway.last("/token/generate-token");
    await linking.onLinkToken(hip, tokenCall.requestId!, { error: { code: "ABDM-1051: ", message: "Invalid ABHA Number or ABHA Address" }, response: { requestId: tokenCall.requestId } });
    assert.ok(store.contexts.every((c) => c.linkStatus === "failed" && c.lastError === "Invalid ABHA Number or ABHA Address (ABDM-1051)"));

    store.patients[0]!.gender = null;
    await assert.rejects(linking.link(hip, PATIENT), LinkingError);
    store.patients[0]!.abhaAddress = null;
    await assert.rejects(linking.link(hip, PATIENT), /no ABHA address/);
    assert.equal(tokenExpiry("not-a-jwt", NOW).getTime() > NOW.getTime() + 150 * 86400_000, true, "six months when the token carries no exp");
});

test("records added to a linked care context are announced once with context/notify", async () => {
    await catalog.refresh(hip, PATIENT);
    const op = store.contexts.find((c) => c.referenceNumber === "OP-101")!;
    Object.assign(op, { linkStatus: "linked", linkedAbhaAddress: "asha.test@sbx", notifiedHiTypes: ["OPConsultation"] });
    const linking = new HipLinkingService(store, catalog, gateway as any, () => NOW);
    assert.equal(await linking.notifyChanges(hip, PATIENT), 1);
    const n = gateway.last("/link/context/notify").body.notification;
    assert.deepEqual(n.hiTypes, ["Prescription"]);
    assert.deepEqual(n.careContext, { patientReference: PATIENT, careContextReference: "OP-101" });
    assert.equal(n.hip.id, HIP);
    assert.equal(await linking.notifyChanges(hip, PATIENT), 0, "nothing new the second time");
});

test("the deep-link SMS goes to the patient's ten digit mobile with the facility's name", async () => {
    const linking = new HipLinkingService(store, catalog, gateway as any, () => NOW);
    await linking.smsNotify(hip, PATIENT);
    assert.deepEqual(gateway.last("/sms/notify2").body, { notification: { phoneNo: "9800000000", hip: { id: HIP, name: "Ocimum Dental Clinic" } } });
});

// ---------- user-initiated linking

const sent: Array<{ to: string; otp: string }> = [];
const sms = { sendOTP: async (to: string, otp: string) => { sent.push({ to, otp }); } };
const patientLinking = () => new PatientLinkingService(store, catalog, sms, gateway as any, () => NOW, () => "246810");

test("fuzzy matching: name parts within one edit in five letters, gender and year of birth agreeing", () => {
    const ours = store.patients[0]!;
    assert.equal(looksLikeSamePerson(ours, { name: "Asha Rao", gender: "F", yearOfBirth: 1990 }), true);
    assert.equal(looksLikeSamePerson(ours, { name: "ASHA  RAO", gender: "F", yearOfBirth: 1991 }), true);
    assert.equal(looksLikeSamePerson(ours, { name: "Aasha", gender: "F" }), true);
    assert.equal(looksLikeSamePerson(ours, { name: "Kiran Rao", gender: "F", yearOfBirth: 1990 }), false);
    assert.equal(looksLikeSamePerson(ours, { name: "Asha Rao", gender: "M", yearOfBirth: 1990 }), false);
    assert.equal(looksLikeSamePerson(ours, { name: "Asha Rao", gender: "F", yearOfBirth: 1980 }), false);
});

test("discovery by ABHA address answers with unlinked care contexts by HI type, the request id and X-HIU-ID", async () => {
    await patientLinking().onDiscover(hip, "disc-1", { "x-hiu-id": "phr-hiu" }, { transactionId: "t-1", patient: { id: "asha.test@sbx", name: "Asha Rao", gender: "F", yearOfBirth: 1990, verifiedIdentifiers: [] } });
    const reply = gateway.last("/care-context/on-discover");
    assert.equal(reply.headers["X-HIU-ID"], "phr-hiu");
    assert.equal(reply.body.transactionId, "t-1");
    assert.deepEqual(reply.body.response, { requestId: "disc-1" });
    assert.deepEqual(reply.body.matchedBy, ["ABHA_ADDRESS"]);
    assert.equal(reply.body.patient[0].referenceNumber, PATIENT);
});

test("discovery by mobile needs the fuzzy match; linked care contexts are not offered; no match is an error", async () => {
    const service = patientLinking();
    const body = (name: string) => ({ transactionId: "t-2", patient: { id: "other@sbx", name, gender: "F", yearOfBirth: 1990, verifiedIdentifiers: [{ type: "MOBILE", value: "9800000000" }] } });
    await catalog.refresh(hip, PATIENT);
    store.contexts.find((c) => c.referenceNumber === "IP-3")!.linkStatus = "linked";

    await service.onDiscover(hip, "disc-2", {}, body("Asha Rao"));
    let reply = gateway.last("/care-context/on-discover").body;
    assert.deepEqual(reply.matchedBy, ["MOBILE"]);
    assert.ok(!JSON.stringify(reply.patient).includes("IP-3"), "linked contexts are left out");

    await service.onDiscover(hip, "disc-3", {}, body("Someone Else"));
    reply = gateway.last("/care-context/on-discover").body;
    assert.equal(reply.error.code, "ABDM-9999");
    assert.equal(reply.patient, undefined);
});

const initBody = (refs: string[], patientRef = PATIENT) => ({
    transactionId: "t-9", abhaAddress: "asha.test@sbx",
    patient: [{ referenceNumber: patientRef, careContexts: refs.map((referenceNumber) => ({ referenceNumber })), hiType: "OPConsultation", count: refs.length }],
});

test("link init texts an OTP, stores only its hash, and answers with the link reference and expiry", async () => {
    sent.length = 0;
    await catalog.refresh(hip, PATIENT);
    await patientLinking().onLinkInit(hip, "init-1", initBody(["OP-101"]));
    assert.deepEqual(sent, [{ to: "9800000000", otp: "246810" }]);
    const reply = gateway.last("/link/care-context/on-init").body;
    assert.equal(reply.link.authenticationType, "DIRECT");
    assert.equal(reply.link.meta.communicationMedium, "MOBILE");
    assert.equal(reply.link.meta.communicationExpiry, new Date(NOW.getTime() + 10 * 60_000).toISOString());
    assert.deepEqual(reply.response, { requestId: "init-1" });
    const stored = store.linkRequests[0]!;
    assert.equal(stored.linkRefNumber, reply.link.referenceNumber);
    assert.ok(!JSON.stringify(stored).includes("246810"), "the OTP itself is not stored");
});

test("link init refuses care contexts that are not the patient's or already linked", async () => {
    await catalog.refresh(hip, PATIENT);
    await patientLinking().onLinkInit(hip, "init-2", initBody(["OP-999"]));
    assert.equal(gateway.last("/on-init").body.error.code, "ABDM-1057");
    store.contexts.find((c) => c.referenceNumber === "OP-101")!.linkStatus = "linked";
    await patientLinking().onLinkInit(hip, "init-3", initBody(["OP-101"]));
    assert.equal(gateway.last("/on-init").body.error.code, "ABDM-1056");
    await patientLinking().onLinkInit(hip, "init-4", initBody(["IP-3"], "not-a-patient"));
    assert.equal(gateway.last("/on-init").body.error.code, "ABDM-1060");
});

test("link confirm: a wrong OTP counts, three end it, an expired one is refused, the right one links", async () => {
    await catalog.refresh(hip, PATIENT);
    const service = patientLinking();
    await service.onLinkInit(hip, "init-5", initBody(["OP-101", "IP-3"]));
    const ref = gateway.last("/on-init").body.link.referenceNumber;

    await service.onLinkConfirm(hip, "conf-1", { confirmation: { linkRefNumber: ref, token: 111111 } });
    assert.equal(gateway.last("/on-confirm").body.error.message, "The OTP is incorrect.");
    await service.onLinkConfirm(hip, "conf-2", { confirmation: { linkRefNumber: ref, token: 246810 } });
    const ok = gateway.last("/on-confirm").body;
    assert.deepEqual(ok.response, { requestId: "conf-2" });
    assert.deepEqual(ok.patient.map((p: any) => p.hiType).sort(), ["DischargeSummary", "OPConsultation", "Prescription"]);
    assert.ok(store.contexts.every((c) => c.linkStatus === "linked" && c.linkedVia === "patient" && c.linkedAbhaAddress === "asha.test@sbx"));
    await service.onLinkConfirm(hip, "conf-3", { confirmation: { linkRefNumber: ref, token: 246810 } });
    assert.match(gateway.last("/on-confirm").body.error.message, /no longer open/);

    store.contexts.forEach((c) => (c.linkStatus = "not-linked"));
    await service.onLinkInit(hip, "init-6", initBody(["OP-101"]));
    const ref2 = gateway.last("/on-init").body.link.referenceNumber;
    for (const n of [1, 2, 3]) await service.onLinkConfirm(hip, `bad-${n}`, { confirmation: { linkRefNumber: ref2, token: 999999 } });
    assert.match(gateway.last("/on-confirm").body.error.message, /three times/);
    assert.equal(store.linkRequests.find((r) => r.linkRefNumber === ref2)!.status, "failed");

    await service.onLinkInit(hip, "init-7", initBody(["OP-101"]));
    const ref3 = gateway.last("/on-init").body.link.referenceNumber;
    const late = new PatientLinkingService(store, catalog, sms, gateway as any, () => new Date(NOW.getTime() + 11 * 60_000));
    await late.onLinkConfirm(hip, "conf-4", { confirmation: { linkRefNumber: ref3, token: 246810 } });
    assert.match(gateway.last("/on-confirm").body.error.message, /expired/);
});

// ---------- consent and data flow

const consentNotification = (status: string, extra: object = {}) => ({
    notification: {
        status, consentId: "c-1", signature: "sig",
        consentDetail: {
            consentId: "c-1", patient: { id: "asha.test@sbx" }, hip: { id: HIP }, hiu: { id: "hiu-1" },
            careContexts: [{ patientReference: PATIENT, careContextReference: "OP-101" }, { patientReference: PATIENT, careContextReference: "IP-3" }],
            hiTypes: ["OPConsultation", "Prescription"],
            permission: { dateRange: { from: "2026-01-01T00:00:00Z", to: "2026-12-31T00:00:00Z" }, dataEraseAt: "2027-01-31T00:00:00Z" },
            purpose: { code: "CAREMGT" },
            ...extra,
        },
    },
});

const healthRecords = {
    forAppointment: async () => {
        const { BUILDERS } = await import("../fhir/health-records.js");
        const { FIXTURES } = await import("../fhir/fhir-fixtures.js");
        return [
            { hiType: "OPConsultation" as const, key: "b-op", bundle: BUILDERS.OPConsultation(FIXTURES.OPConsultation) },
            { hiType: "Invoice" as const, key: "b-inv", bundle: BUILDERS.Invoice(FIXTURES.Invoice) },
        ];
    },
    forDischargeSummary: async () => [],
    forImmunization: async () => [],
    forVitalsRecord: async () => [],
};

test("a consent notification is stored and acknowledged; a revocation updates it", async () => {
    const flow = new DataFlowService(store, healthRecords as any, gateway as any, () => NOW);
    await flow.onConsentNotify(hip, "cn-1", consentNotification("GRANTED"));
    assert.deepEqual(gateway.last("/consent/v3/request/hip/on-notify").body, { acknowledgement: { status: "OK", consentId: "c-1" }, response: { requestId: "cn-1" } });
    assert.equal(store.consents[0]!.status, "GRANTED");
    assert.deepEqual(store.consents[0]!.hiTypes, ["OPConsultation", "Prescription"]);
    await flow.onConsentNotify(hip, "cn-2", { notification: { status: "REVOKED", consentId: "c-1" } });
    assert.equal(store.consents[0]!.status, "REVOKED");
    assert.deepEqual(store.consents[0]!.hiTypes, ["OPConsultation", "Prescription"], "a revocation keeps the grant's details");
});

const hiRequest = (hiu: ReturnType<typeof generateKeyMaterial>, extra: { from?: string; to?: string; consentId?: string } = {}) => ({
    transactionId: "tx-1",
    hiRequest: {
        consent: { id: extra.consentId ?? "c-1" },
        dateRange: { from: extra.from ?? "2026-01-01T00:00:00Z", to: extra.to ?? "2026-12-31T00:00:00Z" },
        dataPushUrl: "https://hiu.example.test/data/push",
        keyMaterial: { cryptoAlg: "ECDH", curve: "Curve25519", dhPublicKey: { expiry: "2026-12-31T00:00:00Z", parameters: "Ephemeral public key", keyValue: hiu.publicKey }, nonce: hiu.nonce },
    },
});

test("a health information request on a granted consent is acknowledged, encrypted, pushed and reported", async () => {
    await catalog.refresh(hip, PATIENT);
    for (const c of store.contexts) Object.assign(c, { linkStatus: "linked", linkedAbhaAddress: "asha.test@sbx" });
    const pushes: any[] = [];
    const flow = new DataFlowService(store, healthRecords as any, gateway as any, () => NOW, async (url, init) => {
        pushes.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        return { ok: true, status: 202 };
    });
    await flow.onConsentNotify(hip, "cn-1", consentNotification("GRANTED"));
    const hiu = generateKeyMaterial();
    await flow.onHealthInformationRequest(hip, "hi-1", hiRequest(hiu));

    assert.deepEqual(gateway.last("/health-information/hip/on-request").body, { hiRequest: { transactionId: "tx-1", sessionStatus: "ACKNOWLEDGED" }, response: { requestId: "hi-1" } });
    assert.equal(pushes.length, 1, "one page: the visit; the stay holds no consented HI type");
    const page = pushes[0].body;
    assert.equal(pushes[0].url, "https://hiu.example.test/data/push");
    assert.equal(pushes[0].headers.Authorization, "Bearer gateway-token");
    assert.deepEqual([page.pageNumber, page.pageCount, page.transactionId], [1, 1, "tx-1"]);
    assert.equal(page.entries.length, 1, "only OPConsultation: the Invoice is not in the consent");
    const entry = page.entries[0];
    assert.equal(entry.careContextReference, "OP-101");
    assert.equal(entry.media, "application/fhir+json");
    const plain = decrypt(entry.content, hiu, { publicKey: page.keyMaterial.dhPublicKey.keyValue, nonce: page.keyMaterial.nonce });
    assert.equal(JSON.parse(plain).type, "document", "the HIU can decrypt it");
    assert.equal(page.keyMaterial.curve, "Curve25519");

    const notify = gateway.last("/health-information/notify").body.notification;
    assert.equal(notify.statusNotification.sessionStatus, "TRANSFERRED");
    assert.deepEqual(notify.statusNotification.statusResponses.map((s: any) => [s.careContextReference, s.hiStatus]).sort(), [["IP-3", "ERRORED"], ["OP-101", "DELIVERED"]]);
    assert.equal(store.transfers[0]!.status, "transferred");

    await flow.onHealthInformationRequest(hip, "hi-2", hiRequest(hiu));
    assert.equal(pushes.length, 1, "the same transaction delivered again is not served twice");
});

test("expired, revoked, unknown or out-of-range consent is refused on on-request and nothing is pushed", async () => {
    let pushed = 0;
    const flow = new DataFlowService(store, healthRecords as any, gateway as any, () => NOW, async () => { pushed++; return { ok: true, status: 202 }; });
    const hiu = generateKeyMaterial();
    const errorOf = () => gateway.last("/on-request").body;

    await flow.onHealthInformationRequest(hip, "r-1", { ...hiRequest(hiu, { consentId: "nope" }), transactionId: "a" });
    assert.equal(errorOf().error.code, "ABDM-1112");
    assert.equal(errorOf().hiRequest.sessionStatus, "ERRORED");

    await flow.onConsentNotify(hip, "cn", consentNotification("GRANTED"));
    await flow.onHealthInformationRequest(hip, "r-2", { ...hiRequest(hiu, { from: "2025-01-01T00:00:00Z" }), transactionId: "b" });
    assert.match(errorOf().error.message, /outside the consented range/);

    await flow.onConsentNotify(hip, "cn", { notification: { status: "REVOKED", consentId: "c-1" } });
    await flow.onHealthInformationRequest(hip, "r-3", { ...hiRequest(hiu), transactionId: "c" });
    assert.equal(errorOf().error.code, "ABDM-1062");

    store.consents[0]!.status = "GRANTED";
    const later = new DataFlowService(store, healthRecords as any, gateway as any, () => new Date("2027-02-01T00:00:00Z"), async () => { pushed++; return { ok: true, status: 202 }; });
    await later.onHealthInformationRequest(hip, "r-4", { ...hiRequest(hiu), transactionId: "d" });
    assert.equal(errorOf().error.code, "ABDM-1061");

    assert.equal(pushed, 0);
    assert.ok(store.transfers.every((t) => t.status === "refused"));
});

// ---------- callback dispatch

test("a stored callback runs its handler after the acknowledgement, and a redelivery does not run it again", async () => {
    const runs: any[] = [];
    const inbound = new Set<string>();
    const callbackStore = {
        answer: async () => "answered" as const,
        receive: async (c: any) => (inbound.has(c.requestId) ? "duplicate" as const : (inbound.add(c.requestId), "stored" as const)),
        handled: async () => {},
    };
    const service = new AbdmCallbackService(callbackStore, { verify: async () => ({}) }, () => NOW, {
        "/api/v3/hip/patient/care-context/discover": async (c) => { runs.push(c); },
    }, { hipById: async (id) => (id === HIP ? hip : null) });
    const headers = { authorization: "Bearer t", "request-id": "d-1", "x-hip-id": HIP };
    const body = { transactionId: "t", patient: { id: "a@sbx" } };
    assert.equal((await service.receive({ path: "/api/v3/hip/patient/care-context/discover", headers, body })).status, 202);
    assert.equal(runs.length, 0, "not before the 202");
    await new Promise((r) => setImmediate(r));
    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0].requestId, runs[0].answers, runs[0].body], ["d-1", null, body]);

    await service.receive({ path: "/api/v3/hip/patient/care-context/discover", headers, body });
    await new Promise((r) => setImmediate(r));
    assert.equal(runs.length, 1, "a redelivery is acknowledged, not handled twice");
});
