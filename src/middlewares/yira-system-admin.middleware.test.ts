import { test } from "node:test";
import assert from "node:assert/strict";
import { createYiraSystemAdminMiddleware, type YiraSystemAdminChecks } from "./yira-system-admin.middleware.js";

const ADMIN = "11111111-1111-1111-1111-111111111111";

const checks = (overrides: Partial<YiraSystemAdminChecks> = {}): YiraSystemAdminChecks => ({
    userIdFromToken: async (token) => (token === "good-token" ? ADMIN : null),
    isYiraSystemAdmin: async () => true,
    ...overrides,
});

const run = async (headers: Record<string, string>, overrides: Partial<YiraSystemAdminChecks> = {}) => {
    const req: any = { headers, body: {}, query: {} };
    const res: any = {
        statusCode: 200,
        body: null,
        status(code: number) { this.statusCode = code; return this; },
        json(body: unknown) { this.body = body; return this; },
    };
    let nextCalled = false;
    await createYiraSystemAdminMiddleware(checks(overrides))(req, res, () => { nextCalled = true; });
    return { req, res, nextCalled };
};

test("no token: refused, and the x-user-id / x-device-id pair does not stand in for one", async () => {
    const { res, nextCalled } = await run({ "x-user-id": ADMIN, "x-device-id": "device-1" });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
});

test("an invalid, expired or revoked token is refused", async () => {
    const { res, nextCalled } = await run({ authorization: "Bearer forged" });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
});

test("a signed-in user without the Yira System Admin role is forbidden", async () => {
    let askedFor = "";
    const { res, nextCalled } = await run({ authorization: "Bearer good-token" }, { isYiraSystemAdmin: async (id) => { askedFor = id; return false; } });
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
    assert.equal(askedFor, ADMIN);
});

test("a failed role check fails closed", async () => {
    const { res, nextCalled } = await run({ authorization: "Bearer good-token" }, { isYiraSystemAdmin: async () => { throw new Error("db down"); } });
    assert.equal(res.statusCode, 500);
    assert.equal(nextCalled, false);
});

test("a Yira System Admin passes, identified by the token rather than a header", async () => {
    const { req, nextCalled } = await run({ authorization: "Bearer good-token", "x-user-id": "someone-else" });
    assert.equal(nextCalled, true);
    assert.equal(req.userId, ADMIN);
});
