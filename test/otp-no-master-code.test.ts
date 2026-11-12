// Only the code that was sent unlocks an OTP session: 123456 / 111111 are not master codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UserOTPRepository } from "../src/repositories/Account/userotp.repository.js";

function repoWith(code: string) {
    const row: any = { SessionId: "s1", Contact: "9000000000", OTP: code, IsExpired: false, AttemptCount: 0, ExpiryTime: new Date(Date.now() + 60_000) };
    const r = new UserOTPRepository() as any;
    r.repo = { findOne: async () => row, save: async () => row };
    return { r: r as UserOTPRepository, row };
}

test("123456 and 111111 are rejected even with ALLOW_TEST_OTP set", async () => {
    process.env.ALLOW_TEST_OTP = "true";
    for (const otp of ["123456", "111111"]) {
        const { r, row } = repoWith("482913");
        const res = await r.verifyOTP("s1", "9000000000", otp);
        assert.equal(res.success, false);
        assert.equal(row.AttemptCount, 1);
        assert.equal(row.IsExpired, false);
    }
});

test("the code that was sent still works", async () => {
    const { r, row } = repoWith("482913");
    const res = await r.verifyOTP("s1", "9000000000", "482913");
    assert.equal(res.success, true);
    assert.equal(row.IsExpired, true);
});
