import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoleMiddleware, createStaffJwtMiddleware, type StaffJwtChecks } from "./staff-jwt.middleware.js";

const STAFF = "11111111-1111-1111-1111-111111111111";

const checks = (overrides: Partial<StaffJwtChecks> = {}): StaffJwtChecks => ({
    verify: (token) => (token === "good-token" ? { userId: STAFF } : null),
    isActiveToken: async () => true,
    hasStaffRole: async () => true,
    ...overrides,
});

const run = async (headers: Record<string, string>, overrides: Partial<StaffJwtChecks> = {}) => {
    const req: any = { headers, body: {}, query: {} };
    const res: any = {
        statusCode: 200,
        body: null,
        status(code: number) { this.statusCode = code; return this; },
        json(body: unknown) { this.body = body; return this; },
    };
    let nextCalled = false;
    await createStaffJwtMiddleware(checks(overrides))(req, res, () => { nextCalled = true; });
    return { req, res, nextCalled };
};

test("the mobile app's x-user-id / x-device-id pair is not accepted instead of a token", async () => {
    const { res, nextCalled } = await run({ "x-user-id": STAFF, "x-device-id": "device-1" });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
});

test("an invalid token is refused", async () => {
    const { res, nextCalled } = await run({ authorization: "Bearer forged" });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
});

test("a revoked token is refused", async () => {
    const { res, nextCalled } = await run({ authorization: "Bearer good-token" }, { isActiveToken: async () => false });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
});

test("a patient-only account is forbidden", async () => {
    const { res, nextCalled } = await run({ authorization: "Bearer good-token" }, { hasStaffRole: async () => false });
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
});

test("signed-in staff pass, identified by the token", async () => {
    const { req, nextCalled } = await run({ authorization: "Bearer good-token", "x-user-id": "someone-else" });
    assert.equal(nextCalled, true);
    assert.equal(req.userId, STAFF);
});

test("a role-restricted route lets through only the named roles, and fails closed", async () => {
    const attempt = async (check: (userId: string, roles: string[]) => Promise<boolean>, userId: string | null = STAFF) => {
        const req: any = { userId };
        const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json() { return this; } };
        let nextCalled = false;
        await createRoleMiddleware(["Yira System Admin"], check)(req, res, () => { nextCalled = true; });
        return { status: res.statusCode, nextCalled };
    };

    let asked: string[] = [];
    assert.deepEqual(await attempt(async (_id, roles) => { asked = roles; return true; }), { status: 200, nextCalled: true });
    assert.deepEqual(asked, ["Yira System Admin"]);
    assert.deepEqual(await attempt(async () => false), { status: 403, nextCalled: false });
    assert.deepEqual(await attempt(async () => { throw new Error("db down"); }), { status: 403, nextCalled: false });
    assert.deepEqual(await attempt(async () => true, null), { status: 403, nextCalled: false }, "no signed-in user");
});
