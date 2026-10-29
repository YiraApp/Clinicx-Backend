import { test } from "node:test";
import assert from "node:assert/strict";
import { abdmHospitalStaff, createAbdmHospitalStaff, type HospitalStaffChecks } from "./abdm-hospital-staff.middleware.js";
import { abdmRouter } from "../routes/Abdm/abdm.routes.js";

const PROVIDER = "11111111-1111-1111-1111-111111111111";
const OTHER_STAFF = "22222222-2222-2222-2222-222222222222";
const HOSPITAL = 20;
const OTHER_HOSPITAL = 21;

/** Staff and the hospitals they hold an active, non-Patient role at; records every check asked. */
const stubChecks = (asked: Array<[string, number]> = []): HospitalStaffChecks => ({
    async staffWorksAt(userId, hospitalId) {
        asked.push([userId, hospitalId]);
        return (userId === PROVIDER && hospitalId === HOSPITAL) || (userId === OTHER_STAFF && hospitalId === OTHER_HOSPITAL);
    },
});

const run = async (userId: string | undefined, headers: Record<string, string>, checks: HospitalStaffChecks = stubChecks()) => {
    const req: any = { headers, params: { userId: "patient" }, userId };
    const res: any = {
        statusCode: 200,
        body: null,
        status(code: number) { this.statusCode = code; return this; },
        json(body: unknown) { this.body = body; return this; },
    };
    let passed = false;
    await createAbdmHospitalStaff(checks)(req, res, () => { passed = true; });
    return { res, passed };
};

test("staff with a role at the hospital they name get through", async () => {
    const asked: Array<[string, number]> = [];
    const { res, passed } = await run(PROVIDER, { "x-hospital-id": String(HOSPITAL) }, stubChecks(asked));
    assert.equal(passed, true);
    assert.equal(res.body, null);
    assert.deepEqual(asked, [[PROVIDER, HOSPITAL]]);
});

test("staff naming a hospital they have no role at are refused with 403, and nothing runs", async () => {
    const { res, passed } = await run(OTHER_STAFF, { "x-hospital-id": String(HOSPITAL) });
    assert.equal(passed, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.status, false);
    assert.equal(res.body.data.kind, "forbidden");
});

test("a request that names no hospital, or not a hospital id, is 400 without a database check", async () => {
    for (const headers of [{} as Record<string, string>, { "x-hospital-id": "" },{ "x-hospital-id": "0" }, { "x-hospital-id": "20; DROP" }, { "x-hospital-id": "-20" }, { "x-hospital-id": "1e3" }]) {
        const asked: Array<[string, number]> = [];
        const { res, passed } = await run(PROVIDER, headers, stubChecks(asked));
        assert.equal(passed, false, JSON.stringify(headers));
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.data.kind, "validation");
        assert.deepEqual(asked, []);
    }
});

test("a caller without a staff user id is 403 without a database check", async () => {
    for (const userId of [undefined, "", "not-a-guid"]) {
        const asked: Array<[string, number]> = [];
        const { res, passed } = await run(userId, { "x-hospital-id": String(HOSPITAL) }, stubChecks(asked));
        assert.equal(passed, false);
        assert.equal(res.statusCode, 403);
        assert.deepEqual(asked, []);
    }
});

test("a failing check is 500 and lets nothing through; no refusal says 'expired', which the desk reads as a lapsed login", async () => {
    const failing: HospitalStaffChecks = { async staffWorksAt() { throw Object.assign(new Error("connection lost"), { code: "ESOCKET" }); } };
    const { res, passed } = await run(PROVIDER, { "x-hospital-id": String(HOSPITAL) }, failing);
    assert.equal(passed, false);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.data.kind, "unexpected");
    for (const [userId, headers] of [[PROVIDER, {}], [OTHER_STAFF, { "x-hospital-id": String(HOSPITAL) }]] as const) {
        assert.doesNotMatch((await run(userId, headers)).res.body.message, /expired/i);
    }
    assert.doesNotMatch(res.body.message, /expired/i);
});

test("every M2 patient route is behind the hospital guard; the M1 ABHA link keeps its own session check", () => {
    const routes = (abdmRouter as any).stack
        .filter((layer: any) => layer.route && String(layer.route.path).startsWith("/patients/:userId/"))
        .map((layer: any) => ({ path: String(layer.route.path), guarded: layer.route.stack.some((s: any) => s.handle === abdmHospitalStaff) }));
    const m2 = routes.filter((r: any) => r.path !== "/patients/:userId/abha");
    assert.deepEqual(m2.map((r: any) => r.path).sort(), [
        "/patients/:userId/care-contexts",
        "/patients/:userId/care-contexts/:reference",
        "/patients/:userId/consents",
        "/patients/:userId/link",
        "/patients/:userId/sms-notify",
    ]);
    for (const r of m2) assert.equal(r.guarded, true, `${r.path} is guarded`);
});
