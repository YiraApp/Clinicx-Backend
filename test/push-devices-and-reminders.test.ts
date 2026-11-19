// Phones that may get pushes, and medicine reminder dates.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerDeviceToken } from "../src/MobileApi/v1/controllers/userdevice.controller.js";
import { userDeviceService } from "../src/MobileApi/v1/services/userdevice.service.js";
import { reminderDate } from "../src/MobileApi/v1/controllers/patient-medication-reminder.controller.js";

const PARENT = "AAAAAAAA-0000-0000-0000-000000000001";
const CHILD = "BBBBBBBB-0000-0000-0000-000000000002";
let registeredFor: string | null = null;

function res() {
    const r: any = { statusCode: 200, body: null };
    r.status = (c: number) => { r.statusCode = c; return r; };
    r.json = (b: any) => { r.body = b; return r; };
    return r;
}

beforeEach(() => {
    registeredFor = null;
    (userDeviceService as any).accountHolderOf = async (id: string) => (id === CHILD ? PARENT : id);
    (userDeviceService as any).registerDeviceToken = async (userId: string) => {
        registeredFor = userId;
        return { Id: 1, UserId: userId, FCMToken: "token", IsActive: true };
    };
});

const body = { userId: CHILD, deviceId: "PHONE-1234", fcmToken: "fcm-token-123456", platform: "ios" };

test("a phone with a family profile's session open stays with the account holder", async () => {
    const req: any = { body, headers: { authorization: "Bearer x" }, user: { userId: CHILD, tokenUserId: CHILD } };
    await registerDeviceToken(req, res());
    assert.equal(registeredFor, PARENT);
});

test("a logged-out token (identity only from the old userId fallback) can't sign the phone up again", async () => {
    const req: any = { body, headers: { authorization: "Bearer revoked" }, user: { userId: CHILD } };
    const r = res();
    await registerDeviceToken(req, r);
    assert.equal(registeredFor, null);
    assert.equal(r.body.status, false);
});

test("old builds that send no token still register by user id", async () => {
    const req: any = { body: { ...body, userId: PARENT }, headers: {}, user: { userId: PARENT } };
    await registerDeviceToken(req, res());
    assert.equal(registeredFor, PARENT);
});

test("reminder dates keep the day the app picked", () => {
    const fallback = new Date(2026, 0, 2, 9);
    assert.equal(reminderDate("2026-11-25T00:00:00.000", fallback), "2026-11-25");
    assert.equal(reminderDate("2026-11-25", fallback), "2026-11-25");
    assert.equal(reminderDate(new Date(2026, 10, 25, 0, 30), fallback), "2026-11-25");
    assert.equal(reminderDate("not a date", fallback), "2026-01-02");
});
