import { test } from "node:test";
import assert from "node:assert/strict";
import { dateOnly } from "./questionnaire-dates.js";

test("a DATE read back as local midnight keeps its calendar day", () => {
    // What the driver returns for DATE '2026-10-01' on a server in India: 2026-10-01 00:00 IST.
    const localMidnight = new Date(2026, 9, 1);
    assert.equal(dateOnly(localMidnight), "2026-10-01");
});

test("strings pass through, empty values are null", () => {
    assert.equal(dateOnly("2026-10-01"), "2026-10-01");
    assert.equal(dateOnly("2026-10-01T00:00:00.000Z"), "2026-10-01");
    assert.equal(dateOnly(null), null);
    assert.equal(dateOnly(""), null);
    assert.equal(dateOnly("not a date"), null);
});
