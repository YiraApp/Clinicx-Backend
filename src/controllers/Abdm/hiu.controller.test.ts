import { test } from "node:test";
import assert from "node:assert/strict";
import { AbdmApiError } from "../../services/Abdm/abdm-gateway.service.js";
import { HiuError } from "../../services/Abdm/hiu/hiu-enums.js";
import { ConsentInitUnansweredError } from "../../services/Abdm/hiu/hiu-consent.service.js";
import { createHiuController, type HiuStaffServices } from "./hiu.controller.js";

const CTX = { staffUserId: "11111111-1111-1111-1111-111111111111", hospitalId: 7, organizationId: 3 };

const calls: { method: string; args: unknown[] }[] = [];
let configured = true;
let failure: unknown = null;
/** The hospital each options call was asked for. */
const optionsAsked: number[] = [];
const NOT_SET_UP = "This hospital isn't set up as an ABDM HIU facility yet. A system admin can add its HFR facility id under ABDM Facilities.";

const record = (method: string, result: unknown) => async (...args: unknown[]) => {
    calls.push({ method, args });
    if (failure) throw failure;
    return result;
};

const services: HiuStaffServices = {
    consent: {
        options: async (ctx) => {
            optionsAsked.push(ctx.hospitalId);
            return { configured, ...(configured ? {} : { reason: NOT_SET_UP }), purposes: [], hiTypes: [], accessModes: ["VIEW"], defaults: { purpose: "CAREMGT" as const, accessMode: "VIEW" as const } };
        },
        patientAbha: record("patientAbha", { userId: "u", name: "N", abhaAddress: null, abhaNumberMasked: null }) as any,
        create: record("create", { id: 1, status: "SENDING" }) as any,
        list: record("list", { items: [], total: 0 }) as any,
        detail: record("detail", { id: 5 }) as any,
        refreshStatus: record("refreshStatus", { id: 5 }) as any,
    },
    dataFlow: {
        records: record("records", { available: false, artefactId: 9, reason: "NOT_RECEIVED" }) as any,
        record: record("record", { available: false, artefactId: 9, reason: "REVOKED" }) as any,
        requestRecords: record("requestRecords", { artefactId: 9 }) as any,
    },
};

const c = createHiuController(async () => services);

const run = async (handler: (req: any, res: any) => Promise<unknown>, req: Partial<{ params: any; query: any; body: any; hiuStaff: any }> = {}) => {
    const res: any = {
        statusCode: 200,
        body: null,
        headers: {} as Record<string, string>,
        setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
        status(code: number) { this.statusCode = code; return this; },
        json(body: unknown) { this.body = body; return this; },
    };
    await handler({ params: {}, query: {}, body: {}, headers: {}, hiuStaff: CTX, ...req }, res);
    return res;
};

const reset = () => {
    calls.length = 0;
    optionsAsked.length = 0;
    configured = true;
    failure = null;
};

test("create answers 202 with the summary, passes only the known fields and the verified context, no-store", async () => {
    reset();
    const res = await run(c.create, { body: { patientUserId: "p", purposeCode: "CAREMGT", hiTypes: ["Prescription"], dateFrom: "2026-01-01", dateTo: "2026-02-01", dataEraseAt: "2027-01-01T00:00:00Z", accessMode: "VIEW", abhaAddress: "evil@sbx", hospitalId: 99 } });
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.status, true);
    assert.deepEqual(res.body.data, { id: 1, status: "SENDING" });
    assert.equal(res.headers["cache-control"], "no-store");
    const [ctx, input] = calls[0]!.args as [any, any];
    assert.deepEqual(ctx, CTX);
    assert.equal("abhaAddress" in input, false);
    assert.equal("hospitalId" in input, false);
});

test("list, detail, refresh-status, patient ABHA and records reach their service with parsed ids", async () => {
    reset();
    assert.equal((await run(c.list, { query: { page: "2", pageSize: "50", status: "GRANTED" } })).statusCode, 200);
    assert.deepEqual(calls[0]!.args[1], { page: 2, pageSize: 50, status: "GRANTED" });
    await run(c.list, { query: { page: "x" } });
    assert.deepEqual(calls[1]!.args[1], { page: 1, pageSize: 20 });
    await run(c.detail, { params: { id: "5" } });
    assert.equal(calls[2]!.args[1], 5);
    await run(c.refreshStatus, { params: { id: "5" } });
    assert.equal(calls[3]!.method, "refreshStatus");
    await run(c.patientAbha, { params: { userId: "u-1" } });
    assert.equal(calls[4]!.args[1], "u-1");
    const records = await run(c.records, { params: { id: "9" } });
    assert.equal(calls[5]!.args[1], 9);
    assert.equal(records.headers["cache-control"], "no-store");
});

test("one record and asking again reach their service with the verified context and parsed ids", async () => {
    reset();
    const one = await run(c.record, { params: { id: "9", recordId: "31" } });
    assert.equal(one.statusCode, 200);
    assert.deepEqual(calls[0]!.args, [CTX, 9, 31]);
    assert.equal(one.headers["cache-control"], "no-store");
    const again = await run(c.requestRecords, { params: { id: "9" }, body: { hospitalId: 99 } });
    assert.equal(again.statusCode, 202);
    assert.deepEqual(calls[1]!.args, [CTX, 9]);
    assert.deepEqual(again.body.data, { artefactId: 9 });
});

test("while the HIU is not set up, options still answers (configured:false) and everything else is 503 not-configured with no service call", async () => {
    reset();
    configured = false;
    const options = await run(c.options);
    assert.equal(options.statusCode, 200);
    assert.equal(options.body.data.configured, false);
    assert.equal(options.body.data.reason, NOT_SET_UP);
    for (const handler of [c.create, c.list, c.detail, c.refreshStatus, c.patientAbha, c.records, c.record, c.requestRecords]) {
        const res = await run(handler, { params: { id: "1", userId: "u" } });
        assert.equal(res.statusCode, 503);
        assert.equal(res.body.data.kind, "not-configured");
        assert.equal(res.body.message, NOT_SET_UP, "the message says this hospital is not set up as an HIU");
        assert.doesNotMatch(res.body.message, /expired/i);
        assert.equal(res.headers["cache-control"], "no-store");
    }
    assert.equal(calls.length, 0);
});

test("whether the HIU is set up is asked for the hospital the access guard verified", async () => {
    reset();
    await run(c.options);
    await run(c.list, { body: { hospitalId: 99 }, query: { hospitalId: "99" } });
    assert.deepEqual(optionsAsked, [CTX.hospitalId, CTX.hospitalId]);
});

test("without the access guard's context nothing runs", async () => {
    reset();
    const res = await run(c.list, { hiuStaff: undefined });
    assert.equal(res.statusCode, 403);
    assert.equal(calls.length, 0);
});

test("a consent init with no answer keeps its 504, says it may have been sent, and names the stored request", async () => {
    reset();
    const cause = new AbdmApiError({ status: 0, kind: "timeout", message: "ABDM did not reply within 30 seconds.", operation: "consent/v3/request/init", requestId: "init-7" });
    failure = new ConsentInitUnansweredError(cause, 7, "init-7");
    const res = await run(c.create);
    assert.equal(res.statusCode, 504);
    assert.equal(res.body.status, false);
    assert.match(res.body.message, /may still have been sent/);
    assert.doesNotMatch(res.body.message, /expired/i);
    assert.equal(res.body.data.kind, "timeout");
    assert.equal(res.body.data.mayHaveBeenSent, true);
    assert.equal(res.body.data.id, 7);
    assert.equal(res.body.data.initRequestId, "init-7");
    assert.equal(res.body.data.requestId, "init-7");
    assert.equal(res.body.data.abdmKind, "timeout");

    // Any other ABDM timeout is unchanged: kind abdm, no flag.
    failure = cause;
    const plain = await run(c.create);
    assert.equal(plain.statusCode, 504);
    assert.equal(plain.body.data.kind, "abdm");
    assert.equal(plain.body.data.mayHaveBeenSent, undefined);
});

test("a HiuError keeps its status, kind and details", async () => {
    reset();
    failure = new HiuError("conflict", "An open request already exists.", { details: { existingId: 4 } });
    const res = await run(c.create);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.status, false);
    assert.equal(res.body.message, "An open request already exists.");
    assert.deepEqual(res.body.data, { kind: "conflict", existingId: 4 });
});

test("an ABDM failure maps like the enrolment controller, ABDM's words in data, never 'expired' in the message", async () => {
    reset();
    failure = new AbdmApiError({ status: 400, kind: "rejected", message: "Consent request expired token", operation: "consent/request/init", code: "ABDM-1040", requestId: "r-1" });
    const rejected = await run(c.create);
    assert.equal(rejected.statusCode, 422);
    assert.doesNotMatch(rejected.body.message, /expired/i);
    assert.equal(rejected.body.data.kind, "abdm");
    assert.equal(rejected.body.data.abdmCode, "ABDM-1040");
    assert.equal(rejected.body.data.abdmMessage, "Consent request expired token");
    assert.equal(rejected.body.data.requestId, "r-1");

    failure = new AbdmApiError({ status: 0, kind: "timeout", message: "timed out", operation: "x" });
    assert.equal((await run(c.refreshStatus, { params: { id: "1" } })).statusCode, 504);
    failure = new AbdmApiError({ status: 401, kind: "credentials", message: "bad", operation: "x" });
    assert.equal((await run(c.refreshStatus, { params: { id: "1" } })).statusCode, 502, "ABDM's 401 never reaches the app as 401");
    failure = new AbdmApiError({ status: 0, kind: "not-configured", message: "no client", operation: "x" });
    const notConfigured = await run(c.refreshStatus, { params: { id: "1" } });
    assert.equal(notConfigured.statusCode, 503);
    assert.equal(notConfigured.body.data.kind, "not-configured");

    failure = new Error("Violation of UNIQUE KEY someone@sbx");
    const unexpected = await run(c.list);
    assert.equal(unexpected.statusCode, 500);
    assert.doesNotMatch(JSON.stringify(unexpected.body), /someone/);
});
