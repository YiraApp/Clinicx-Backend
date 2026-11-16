import { test } from "node:test";
import assert from "node:assert/strict";
import { isWithinEditWindow } from "./edit-window.js";

test("a prescription or record can be changed for one hour after saving", () => {
    const now = new Date("2026-11-16T12:00:00Z");
    assert.equal(isWithinEditWindow("2026-11-16T11:30:00Z", now), true);
    assert.equal(isWithinEditWindow("2026-11-16T11:00:00Z", now), true, "exactly one hour");
    assert.equal(isWithinEditWindow("2026-11-16T10:59:00Z", now), false);
    assert.equal(isWithinEditWindow(new Date("2026-11-15T12:00:00Z"), now), false);
});

test("unknown age stays editable", () => {
    assert.equal(isWithinEditWindow(null), true);
    assert.equal(isWithinEditWindow("not a date"), true);
});
