import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AppDataSource } from "../../config/database.js";
import { AbdmM2Repository } from "../../repositories/Abdm/abdm-m2.repository.js";
import { HipConsentsService, maskAbhaAddress, type HipConsentStore, type StoredHipConsent, type StoredHipTransfer } from "../../services/Abdm/m2/hip-consents.js";
import type { Hip, PatientProfile } from "../../services/Abdm/m2/m2-store.js";
import { AbdmM2Controller } from "./abdm-m2.controller.js";

/** GET /api/abdm/patients/:userId/consents: the consents this HIP holds for a patient, read-only. */

const HIP: Hip = { id: "IN3610000001", hospitalId: 12, name: "ClinicX Test Hospital" };
const PATIENT = "0f6c2b8e-1d2a-4c55-9d7e-0a1b2c3d4e5f";
const OTHER_PATIENT = "9a8b7c6d-0000-4000-8000-000000000001";
const ABHA = "asha.test@sbx";
const NOW = new Date("2026-10-29T10:00:00Z");
const ARTEFACT = '{"consentId":"c-1","patient":{"id":"asha.test@sbx"}}';
const SIGNATURE = "c2lnbmF0dXJlLW9mLXRoZS1hcnRlZmFjdA==";

const profile: PatientProfile = { userId: PATIENT, name: "Asha Rao", gender: "Female", birthDate: "1990-04-12", phone: "+919800000000", abhaNumber: null, abhaAddress: ABHA };

const consent = (over: Partial<StoredHipConsent> & { consentId: string }): StoredHipConsent => ({
    hipId: HIP.id, status: "GRANTED", patientAbhaAddress: ABHA, hiuId: "IN3610000099", hiTypes: ["Prescription", "OPConsultation"],
    careContexts: [{ patientReference: PATIENT, careContextReference: "VISIT-101" }],
    dateFrom: new Date("2025-01-01T00:00:00Z"), dateTo: new Date("2026-10-28T00:00:00Z"), dataEraseAt: new Date("2026-12-31T00:00:00Z"),
    purpose: "CAREMGT", createdAt: new Date("2026-10-28T09:00:00Z"), updatedAt: null,
    ...over,
});

const transfer = (over: Partial<StoredHipTransfer> & { transactionId: string; consentId: string }): StoredHipTransfer => ({
    status: "transferred", results: [], error: null, createdAt: new Date("2026-10-28T09:05:00Z"), completedAt: new Date("2026-10-28T09:05:10Z"),
    ...over,
});

/** A store with [consents] and [transfers]; records what the ledger was asked. */
const storeWith = (consents: StoredHipConsent[], transfers: StoredHipTransfer[] = [], patients: PatientProfile[] = [profile]) => {
    const asked: Array<{ method: string; args: unknown[] }> = [];
    const store: HipConsentStore = {
        async patient(id) { return patients.find((p) => p.userId === id.toLowerCase()) ?? null; },
        async consentsFor(hipId, reference) {
            asked.push({ method: "consentsFor", args: [hipId, reference] });
            // Rows as a careless query might return them: with the artefact and signature still on
            return consents.map((c) => ({ ...c, artefact: ARTEFACT, signature: SIGNATURE }));
        },
        async transfersFor(hipId, ids) {
            asked.push({ method: "transfersFor", args: [hipId, ids] });
            return transfers.filter((t) => ids.includes(t.consentId)).map((t) => ({ ...t, dataPushUrl: "https://hiu.example/push?token=secret" }));
        },
    };
    return { store, asked };
};

const hospitals: number[] = [];
const facilities = { async hip(hospitalId: number | null | undefined) { hospitals.push(Number(hospitalId)); return hospitalId === HIP.hospitalId ? HIP : null; } };

const controllerOver = (store: HipConsentStore) => new AbdmM2Controller(new HipConsentsService(store, facilities, () => NOW));

const run = async (controller: AbdmM2Controller, userId: string, hospital: number | null = HIP.hospitalId) => {
    const res: any = {
        statusCode: 200,
        body: null,
        headers: {} as Record<string, string>,
        setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
        status(code: number) { this.statusCode = code; return this; },
        json(body: unknown) { this.body = body; return this; },
    };
    await controller.consents({ params: { userId }, headers: hospital ? { "x-hospital-id": String(hospital) } : {} } as any, res);
    return res;
};

afterEach(() => { hospitals.length = 0; });

test("lists the patient's consents newest first, with HI types, care contexts, date range, purpose, expiry and status", async () => {
    const { store, asked } = storeWith([
        consent({ consentId: "c-old", createdAt: new Date("2026-10-20T09:00:00Z"), hiTypes: ["DiagnosticReport"], purpose: "PATRQT" }),
        consent({ consentId: "c-new", createdAt: new Date("2026-10-28T09:00:00Z") }),
    ]);
    const res = await run(controllerOver(store), PATIENT);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, true);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(hospitals, [HIP.hospitalId], "the HIP is the one for X-Hospital-Id");
    assert.deepEqual(asked[0], { method: "consentsFor", args: [HIP.id, PATIENT] });

    const { hip, consents } = res.body.data;
    assert.deepEqual(hip, { id: HIP.id, name: HIP.name, hospitalId: HIP.hospitalId });
    assert.deepEqual(consents.map((c: any) => c.consentId), ["c-new", "c-old"]);
    const [latest, older] = consents;
    assert.deepEqual(latest.hiTypes, ["Prescription", "OPConsultation"]);
    assert.deepEqual(latest.careContextReferences, ["VISIT-101"]);
    assert.equal(latest.dateFrom, "2025-01-01T00:00:00.000Z");
    assert.equal(latest.dateTo, "2026-10-28T00:00:00.000Z");
    assert.equal(latest.dataEraseAt, "2026-12-31T00:00:00.000Z");
    assert.deepEqual(latest.purpose, { code: "CAREMGT", text: "Care Management" });
    assert.deepEqual(older.purpose, { code: "PATRQT", text: "Self Requested" });
    assert.equal(latest.status, "GRANTED");
    assert.equal(latest.active, true);
    assert.equal(latest.hiuId, "IN3610000099");
    assert.equal(latest.receivedAt, "2026-10-28T09:00:00.000Z");
});

test("never returns the artefact, the signature, the push URL, the full ABHA address or the patient reference", async () => {
    const { store } = storeWith(
        [consent({ consentId: "c-1" })],
        [transfer({ transactionId: "t-1", consentId: "c-1", results: [{ careContextReference: "VISIT-101", hiStatus: "DELIVERED", description: "Delivered" }] })],
    );
    const res = await run(controllerOver(store), PATIENT);
    const [c] = res.body.data.consents;
    assert.equal(c.patientAbhaAddress, "****@sbx");
    for (const key of ["artefact", "Artefact", "signature", "Signature", "careContexts"]) assert.equal(key in c, false, `no ${key}`);
    assert.equal("dataPushUrl" in c.transfers[0], false);
    const text = JSON.stringify(res.body);
    for (const leak of [ARTEFACT, SIGNATURE, ABHA, PATIENT, "token=secret"]) assert.equal(text.includes(leak), false, `the body does not carry ${leak}`);
});

test("masks any ABHA address to its last four characters", () => {
    assert.equal(maskAbhaAddress("asha.test@sbx"), "****@sbx");
    assert.equal(maskAbhaAddress("ab@abdm"), "****abdm");
    assert.equal(maskAbhaAddress("abcd"), "****");
    assert.equal(maskAbhaAddress(null), null);
    assert.equal(maskAbhaAddress(""), null);
});

test("each consent carries its transfers, newest first, with their results and delivered/errored counts", async () => {
    const { store, asked } = storeWith(
        [consent({ consentId: "c-1", careContexts: [{ patientReference: PATIENT, careContextReference: "VISIT-101" }, { patientReference: PATIENT, careContextReference: "IMM-7" }] }), consent({ consentId: "c-2" })],
        [
            transfer({ transactionId: "t-first", consentId: "c-1", createdAt: new Date("2026-10-28T09:05:00Z"), results: [
                { careContextReference: "VISIT-101", hiStatus: "DELIVERED", description: "Delivered" },
                { careContextReference: "IMM-7", hiStatus: "ERRORED", description: "Outside the consented date range." },
            ] }),
            transfer({ transactionId: "t-second", consentId: "c-1", createdAt: new Date("2026-10-28T11:00:00Z"), results: [
                { careContextReference: "VISIT-101", hiStatus: "DELIVERED", description: "Delivered" },
                { careContextReference: "IMM-7", hiStatus: "DELIVERED", description: "Delivered" },
            ] }),
            transfer({ transactionId: "t-refused", consentId: "c-2", status: "refused", results: null, error: "ABDM-1062: Consent not granted (REVOKED)." }),
        ],
    );
    const res = await run(controllerOver(store), PATIENT);
    assert.deepEqual(asked[1], { method: "transfersFor", args: [HIP.id, ["c-1", "c-2"]] });
    const [one, two] = res.body.data.consents;
    assert.deepEqual(one.transfers.map((t: any) => t.transactionId), ["t-second", "t-first"]);
    assert.deepEqual(one.transfers[1].results, [
        { careContextReference: "VISIT-101", hiStatus: "DELIVERED", description: "Delivered" },
        { careContextReference: "IMM-7", hiStatus: "ERRORED", description: "Outside the consented date range." },
    ]);
    assert.equal(one.transfers[1].delivered, 1);
    assert.equal(one.transfers[1].errored, 1);
    assert.equal(one.transfers[1].completedAt, "2026-10-28T09:05:10.000Z");
    assert.equal(one.delivered, 3);
    assert.equal(one.errored, 1);
    assert.deepEqual(two.transfers.map((t: any) => [t.status, t.error, t.results, t.delivered, t.errored]), [["refused", "ABDM-1062: Consent not granted (REVOKED).", [], 0, 0]]);
});

test("shows only the patient's own care contexts of a consent, matched on the reference in lower case", async () => {
    const { store, asked } = storeWith([consent({
        consentId: "c-1",
        careContexts: [{ patientReference: PATIENT.toUpperCase(), careContextReference: "VISIT-101" }, { patientReference: OTHER_PATIENT, careContextReference: "VISIT-999" }],
    })]);
    const res = await run(controllerOver(store), PATIENT.toUpperCase());
    assert.deepEqual(asked[0]!.args, [HIP.id, PATIENT]);
    assert.deepEqual(res.body.data.consents[0].careContextReferences, ["VISIT-101"]);
});

test("a revoked consent, and a granted one past its erase date, are not active", async () => {
    const { store } = storeWith([
        consent({ consentId: "c-revoked", status: "REVOKED", createdAt: new Date("2026-10-28T09:00:00Z") }),
        consent({ consentId: "c-lapsed", status: "GRANTED", dataEraseAt: new Date("2026-10-29T09:59:00Z"), createdAt: new Date("2026-10-27T09:00:00Z") }),
        consent({ consentId: "c-open", status: "GRANTED", dataEraseAt: null, purpose: "NEWCODE", createdAt: new Date("2026-10-26T09:00:00Z") }),
    ]);
    const res = await run(controllerOver(store), PATIENT);
    assert.deepEqual(res.body.data.consents.map((c: any) => [c.consentId, c.status, c.active]), [
        ["c-revoked", "REVOKED", false], ["c-lapsed", "GRANTED", false], ["c-open", "GRANTED", true],
    ]);
    assert.deepEqual(res.body.data.consents[2].purpose, { code: "NEWCODE", text: "NEWCODE" }, "an unknown purpose shows its code");
});

test("a patient with no consents gets an empty list and no transfer lookup", async () => {
    const { store, asked } = storeWith([]);
    const res = await run(controllerOver(store), PATIENT);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.consents, []);
    assert.deepEqual(asked.map((a) => a.method), ["consentsFor"]);
});

test("a hospital that is not an ABDM facility answers hip null and no consents, without reading the ledger", async () => {
    const { store, asked } = storeWith([consent({ consentId: "c-1" })]);
    for (const hospital of [99, null]) {
        const res = await run(controllerOver(store), PATIENT, hospital);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.data, { hip: null, consents: [] });
    }
    assert.deepEqual(asked, []);
});

test("an unknown patient is 404, without reading the ledger", async () => {
    const { store, asked } = storeWith([consent({ consentId: "c-1" })]);
    const res = await run(controllerOver(store), OTHER_PATIENT);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.status, false);
    assert.deepEqual(asked, []);
});

test("a failing store answers 500 with a generic message, never the database's", async () => {
    const { store } = storeWith([]);
    store.consentsFor = async () => { throw new Error("Invalid column name 'Artefact'"); };
    const res = await run(controllerOver(store), PATIENT);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.data.kind, "unexpected");
    assert.doesNotMatch(JSON.stringify(res.body), /Artefact|column|expired/i);
});

// ---------------------------------------------------------------------------------------------
// The SQL behind it

const realQuery = AppDataSource.query;
afterEach(() => { (AppDataSource as any).query = realQuery; });

const answering = (answer: (sql: string, params: unknown[]) => any[]) => {
    const sent: Array<{ sql: string; params: unknown[] }> = [];
    (AppDataSource as any).query = async (sql: string, params: unknown[] = []) => {
        sent.push({ sql, params });
        return answer(sql, params);
    };
    return sent;
};

test("the consent query is for the HIP and the patient, never selects the artefact or signature, and keeps only exact patient matches", async () => {
    const row = (consentId: string, careContexts: unknown) => ({
        ConsentId: consentId, HipId: HIP.id, Status: "GRANTED", PatientAbhaAddress: ABHA, HiuId: "IN3610000099", HiTypes: '["Prescription"]',
        CareContexts: JSON.stringify(careContexts), DateFrom: "2025-01-01T00:00:00Z", DateTo: "2026-10-28T00:00:00Z", DataEraseAt: "2026-12-31T00:00:00Z",
        // GETDATE() stamps, as the query returns them: UTC text with no zone (style 126)
        Purpose: "CAREMGT", CreatedAt: "2026-10-28T09:00:00.120", UpdatedAt: "2026-10-28T10:30:00",
    });
    const sent = answering(() => [
        row("c-mine", [{ patientReference: PATIENT, careContextReference: "VISIT-101" }]),
        // Matched by LIKE as text, but the reference is a longer one: not this patient
        row("c-lookalike", [{ patientReference: `${PATIENT}-x`, careContextReference: "VISIT-5" }]),
    ]);
    const consents = await new AbdmM2Repository().consentsFor(HIP.id, PATIENT);
    assert.deepEqual(consents.map((c) => c.consentId), ["c-mine"]);
    assert.deepEqual(consents[0]!.hiTypes, ["Prescription"]);
    assert.equal(consents[0]!.createdAt.toISOString(), "2026-10-28T09:00:00.120Z");
    assert.equal(consents[0]!.updatedAt?.toISOString(), "2026-10-28T10:30:00.000Z");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.params, [HIP.id, PATIENT]);
    assert.match(sent[0]!.sql, /FROM AbdmConsents WHERE HipId = @0/);
    assert.doesNotMatch(sent[0]!.sql, /\*|Artefact|Signature/);
});

test("GETDATE() stamps are read as UTC by the database's own offset, not as the app's local time", async () => {
    const sent = answering(() => []);
    const repository = new AbdmM2Repository();
    await repository.consentsFor(HIP.id, PATIENT);
    await repository.transfersFor(HIP.id, ["c-1"]);
    const utc = (column: string) => new RegExp(`CONVERT\\(varchar\\(23\\), DATEADD\\(MINUTE, -DATEPART\\(TZOFFSET, SYSDATETIMEOFFSET\\(\\)\\), ${column}\\), 126\\) AS ${column}`);
    for (const column of ["CreatedAt", "UpdatedAt"]) assert.match(sent[0]!.sql, utc(column));
    for (const column of ["CreatedAt", "CompletedAt"]) assert.match(sent[1]!.sql, utc(column));
    // Ordered by the stored column, not by the text alias
    assert.match(sent[0]!.sql, /ORDER BY AbdmConsents\.CreatedAt DESC/);
    assert.match(sent[1]!.sql, /ORDER BY AbdmDataTransfers\.CreatedAt DESC/);
});

test("the transfer query is for the HIP and the consents, and never selects the push URL", async () => {
    const sent = answering(() => [{
        TransactionId: "t-1", ConsentId: "c-1", Status: "transferred", Results: '[{"careContextReference":"VISIT-101","hiStatus":"DELIVERED"}]',
        Error: null, CreatedAt: "2026-10-28T09:05:00", CompletedAt: "2026-10-28T09:05:10.5",
    }]);
    const repository = new AbdmM2Repository();
    const transfers = await repository.transfersFor(HIP.id, ["c-1", "c-2"]);
    assert.deepEqual(sent[0]!.params, [HIP.id, "c-1", "c-2"]);
    assert.match(sent[0]!.sql, /ConsentId IN \(@1, @2\)/);
    assert.doesNotMatch(sent[0]!.sql, /\*|DataPushUrl/);
    assert.deepEqual(transfers[0]!.results, [{ careContextReference: "VISIT-101", hiStatus: "DELIVERED" }]);
    assert.equal(transfers[0]!.createdAt.toISOString(), "2026-10-28T09:05:00.000Z");
    assert.equal(transfers[0]!.completedAt?.toISOString(), "2026-10-28T09:05:10.500Z");
    assert.deepEqual(await repository.transfersFor(HIP.id, []), []);
    assert.equal(sent.length, 1, "no query for no consents");
});
