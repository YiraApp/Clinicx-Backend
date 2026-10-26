import { test } from "node:test";
import assert from "node:assert/strict";
import { createStaffJwtMiddleware, type StaffJwtChecks } from "./staff-jwt.middleware.js";

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
