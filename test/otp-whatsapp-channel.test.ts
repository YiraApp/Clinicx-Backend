// Numbers outside India can ask for the login / sign-up code on WhatsApp: the app sends channel "whatsapp".
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sendOTP, resendOTP, sendSignupOtp } from "../src/MobileApi/v1/controllers/auth.controller.js";
import { mobileAuthService as svc } from "../src/MobileApi/v1/services/mobile-auth.service.js";
import { otpService } from "../src/services/Account/otp.service.js";

const seen: any[] = [];
function res() {
    const r: any = { statusCode: 200, body: null };
    r.status = (c: number) => { r.statusCode = c; return r; };
    r.json = (b: any) => { r.body = b; return r; };
    return r;
}
const ok = { otpSent: true, sessionId: "s1", contact: "5551234567", contactType: "MOBILE", message: "sent" };

beforeEach(() => {
    seen.length = 0;
    (svc as any).sendOTP = async (...args: any[]) => { seen.push(["login", ...args]); return ok; };
    (svc as any).sendSignupOTP = async (...args: any[]) => { seen.push(["signup", ...args]); return ok; };
});

test("login OTP passes channel whatsapp through", async () => {
    await sendOTP({ body: { identity: "5551234567", countryCode: "1", channel: "whatsapp" } } as any, res());
    assert.deepEqual(seen[0], ["login", "5551234567", "1", false, "whatsapp"]);
});

test("resend and sign-up pass the channel too", async () => {
    await resendOTP({ body: { contact: "5551234567", countryCode: "971", channel: "whatsapp" } } as any, res());
    await sendSignupOtp({ body: { phoneNumber: "5551234567", countryCode: "971", channel: "whatsapp" } } as any, res());
    assert.equal(seen[0][4], "whatsapp");
    assert.equal(seen[1][4], "whatsapp");
});

test("no channel or an unknown one keeps the SMS default", async () => {
    await sendOTP({ body: { identity: "9876543210", countryCode: "91" } } as any, res());
    await sendOTP({ body: { identity: "9876543210", countryCode: "91", channel: "telegram" } } as any, res());
    assert.equal(seen[0][4], undefined);
    assert.equal(seen[1][4], undefined);
});

test("the OTP service gets the channel as its channel argument", async () => {
    const real = (await import("../src/MobileApi/v1/services/mobile-auth.service.js")).MobileAuthService;
    const repo = (await import("../src/MobileApi/v1/repositories/mobile-auth.repository.js")).mobileAuthRepository as any;
    repo.findPrimaryUser = async () => ({ Id: "u1", PhoneNumber: "5551234567", Status: true, IsDeleted: false, CountryCode: "1" });
    repo.findUserRoles = async () => [{ RoleId: "4FC67429-28AE-4106-93EF-436228282ED0" }];
    let channelArg: any = "unset";
    (otpService as any).sendOTP = async (_c: any, _p: any, _cc: any, _t: any, _d: any, channel: any) => {
        channelArg = channel;
        return { sessionId: "s1", contactType: "MOBILE", message: "sent" };
    };
    await new real().sendOTP("5551234567", "1", false, "whatsapp");
    assert.equal(channelArg, "whatsapp");
});
