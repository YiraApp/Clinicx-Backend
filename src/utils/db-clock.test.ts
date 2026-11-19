import { test } from "node:test";
import assert from "node:assert/strict";
import { fromDbClock, prescriptionIssuedAt } from "./db-clock.js";

// Tests run with TZ=Asia/Kolkata, as the server does (src/index.ts). The driver reads the UTC clock a
// GETDATE() default stamped as if it were this process's clock: 05:08:55 UTC comes back as 05:08:55 IST.
const asTheDriverReadsIt = (utcWallClock: string) => {
    const [d, t] = utcWallClock.split("T");
    const [y, mo, da] = d!.split("-").map(Number);
    const [h, mi, s] = t!.split(":").map(Number);
    return new Date(y!, mo! - 1, da!, h!, mi!, s!);
};

test("a database stamp read as IST is put back to the instant it was stamped", () => {
    const read = asTheDriverReadsIt("2026-11-18T05:08:55");
    assert.equal(read.toISOString(), "2026-11-17T23:38:55.000Z", "5h30 early, as the PDF printed it (05:08 am)");
    assert.equal(fromDbClock(read).toISOString(), "2026-11-18T05:08:55.000Z", "10:38:55 IST, when it was saved");
});

test("a prescription is issued at its database-stamped Date, read right; CreatedAt as stored only without one", () => {
    const stamped = asTheDriverReadsIt("2026-11-18T05:08:55");
    // The usual save: both columns are GETDATE() defaults
    assert.equal(prescriptionIssuedAt({ Date: stamped, CreatedAt: stamped })!.toISOString(), "2026-11-18T05:08:55.000Z");
    // The client sent createdAt (IST, already right): Date still says the same instant
    const clientIst = new Date("2026-11-13T18:53:04+05:30");
    assert.equal(prescriptionIssuedAt({ Date: asTheDriverReadsIt("2026-11-13T13:23:04"), CreatedAt: clientIst })!.toISOString(), clientIst.toISOString());
    assert.equal(prescriptionIssuedAt({ Date: null, CreatedAt: clientIst })!.toISOString(), clientIst.toISOString());
    assert.equal(prescriptionIssuedAt({}), undefined);
});
