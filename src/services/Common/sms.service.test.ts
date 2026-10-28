import { test } from "node:test";
import assert from "node:assert/strict";
import { SMSService } from "./sms.service.js";

test("the ABHA linking OTP goes to 91 + the mobile on the DLT route, not the international one", async () => {
    Object.assign(process.env, { SMS_USER: "u", SMS_PASSWORD: "p", SMS_BASE_URL: "https://sms.example.test/API/sms.php", SMS_TYPE: "1", SMS_FROM: "YIRAAI" });
    const realFetch = globalThis.fetch;
    const realLog = console.log;
    const urls: URL[] = [];
    globalThis.fetch = (async (url: string) => { urls.push(new URL(url)); return { text: async () => "Message Sent" }; }) as any;
    console.log = () => {};
    try {
        await new SMSService().sendAbhaLinkOtp("+91 98000 00000", "246810");
        await assert.rejects(new SMSService().sendAbhaLinkOtp("12345", "246810"), /10 digit/);
    } finally {
        globalThis.fetch = realFetch;
        console.log = realLog;
    }
    assert.equal(urls.length, 1);
    const q = urls[0]!.searchParams;
    assert.equal(urls[0]!.hostname, "sms.example.test", "SMS Striker, not 2Factor");
    assert.equal(q.get("to"), "919800000000");
    assert.equal(q.get("template_id"), "1707174617963880388", "the ABHA OTP template");
    assert.equal(q.get("msg"), "Your verification code for linking your Care Context with ABHA is 246810. \u2014 Powered by Yira.ai.");
});
