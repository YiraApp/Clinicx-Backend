import { test } from "node:test";
import assert from "node:assert/strict";
import { createAbdmHiuAccess, hiuAccessQuery, hiuStaffContext, type HiuAccessChecks } from "./abdm-hiu-access.middleware.js";

const DOCTOR = "11111111-1111-1111-1111-111111111111";
const FRONT_DESK = "22222222-2222-2222-2222-222222222222";
const PATIENT = "33333333-3333-3333-3333-333333333333";

/** The role assignments a stub database holds: active roles only, as the real query reads them. */
const ASSIGNMENTS = [
    { userId: DOCTOR, hospitalId: 7, roleName: "PROVIDER", organizationId: 3 },
    { userId: FRONT_DESK, hospitalId: 7, roleName: "Front Desk", organizationId: 3 },
    { userId: PATIENT, hospitalId: 7, roleName: "Patient", organizationId: 3 },
];

const stubChecks = (calls: { roleNames: string[] }[] = []): HiuAccessChecks => ({
    roleNames: () => ["Provider", "Hospital Admin"],
    async staffAccess(userId, hospitalId, roleNames) {
        calls.push({ roleNames });
        const wanted = roleNames.map((name) => name.toUpperCase());
        const row = ASSIGNMENTS.find((a) => a.userId === userId && a.hospitalId === hospitalId && wanted.includes(a.roleName.toUpperCase()));
        return row ? { organizationId: row.organizationId } : null;
    },
});

const run = async (userId: string | undefined, headers: Record<string, string>, checks: HiuAccessChecks = stubChecks()) => {
    const req: any = { headers, body: {}, query: {}, userId };
    const res: any = {
        statusCode: 200,
        body: null,
        headers: {} as Record<string, string>,
        setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
        status(code: number) { this.statusCode = code; return this; },
        json(body: unknown) { this.body = body; return this; },
    };
    let nextCalled = false;
    await createAbdmHiuAccess(checks)(req, res, () => { nextCalled = true; });
    return { req, res, nextCalled };
};

test("a request naming no hospital is refused with 400, before any database check", async () => {
    let checked = 0;
    const checks = { ...stubChecks(), staffAccess: async () => { checked += 1; return { organizationId: 3 }; } };
    for (const headers of [{} as Record<string, string>, { "x-hospital-id": "" }, { "x-hospital-id": "abc" }, { "x-hospital-id": "0" }, { "x-hospital-id": "-7" }]) {
        const { res, nextCalled } = await run(DOCTOR, headers, checks);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.status, false);
        assert.equal(res.body.data.kind, "validation");
        assert.equal(nextCalled, false);
    }
    assert.equal(checked, 0);
});

test("a patient is refused", async () => {
    const { res, nextCalled } = await run(PATIENT, { "x-hospital-id": "7" });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.data.kind, "forbidden");
    assert.equal(nextCalled, false);
});

test("staff with a role not named in ABDM_HIU_ROLE_NAMES are refused", async () => {
    const { res, nextCalled } = await run(FRONT_DESK, { "x-hospital-id": "7" });
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
});

test("an allowed role at another hospital does not open this one", async () => {
    const { res, nextCalled } = await run(DOCTOR, { "x-hospital-id": "8" });
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
});

test("a role claimed only in the headers is never trusted", async () => {
    const calls: { roleNames: string[] }[] = [];
    const { res, nextCalled } = await run(FRONT_DESK, { "x-hospital-id": "7", "x-role-name": "Provider", "x-role-id": "provider-role" }, stubChecks(calls));
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
    assert.deepEqual(calls[0]?.roleNames, ["Provider", "Hospital Admin"], "the configured names are checked, not the header");
});

test("a missing or malformed staff id is refused", async () => {
    for (const userId of [undefined, "not-a-guid"]) {
        const { res, nextCalled } = await run(userId, { "x-hospital-id": "7" });
        assert.equal(res.statusCode, 403);
        assert.equal(nextCalled, false);
    }
});

test("an allowed role at the named hospital passes, with the verified context attached", async () => {
    const { req, res, nextCalled } = await run(DOCTOR, { "x-hospital-id": "7", "x-org-id": "999" });
    assert.equal(nextCalled, true);
    assert.deepEqual(hiuStaffContext(req), { staffUserId: DOCTOR, hospitalId: 7, organizationId: 3 });
    assert.equal(res.headers["cache-control"], "no-store");
});

test("a failing database check fails closed", async () => {
    const checks = { ...stubChecks(), staffAccess: async () => { throw Object.assign(new Error("db down"), { code: "ESOCKET" }); } };
    const { res, nextCalled } = await run(DOCTOR, { "x-hospital-id": "7" }, checks);
    assert.equal(res.statusCode, 500);
    assert.equal(nextCalled, false);
});

test("the access query matches role names case-insensitively, by name or normalized name, at the hospital", () => {
    const { sql, parameters } = hiuAccessQuery(DOCTOR, 7, [" Provider ", "hospital admin", "PROVIDER"]);
    assert.deepEqual(parameters, [DOCTOR, 7, "PROVIDER", "HOSPITAL ADMIN"]);
    assert.match(sql, /ur\.UserId = @0 AND ur\.HospitalId = @1 AND ur\.IsDeleted = 0 AND ur\.Status = 1/);
    assert.match(sql, /UPPER\(LTRIM\(RTRIM\(r\.RoleName\)\)\) IN \(@2, @3\)/);
    assert.match(sql, /UPPER\(LTRIM\(RTRIM\(r\.NormalizedName\)\)\) IN \(@2, @3\)/);
});
