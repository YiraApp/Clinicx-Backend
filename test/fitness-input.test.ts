// Checks for the fitness sync's input rules. No database needed.
// Run: npx tsx --test test/fitness-input.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    addDays,
    boundedJson,
    isCalendarDate,
    isDuplicateKeyError,
    isGuid,
    isSyncableDate,
    localDateKey,
} from "../src/services/Fitness/fitness-input.js";

test("only real calendar dates pass", () => {
    assert.equal(isCalendarDate("2026-11-12"), true);
    assert.equal(isCalendarDate("2024-02-29"), true);
    assert.equal(isCalendarDate("2026-02-29"), false);
    assert.equal(isCalendarDate("2026-02-30"), false);
    assert.equal(isCalendarDate("2026-13-01"), false);
    assert.equal(isCalendarDate("2026-11-12T00:00:00Z"), false);
    assert.equal(isCalendarDate(undefined), false);
    assert.equal(isCalendarDate(20261112), false);
});

test("a phone can sync up to tomorrow, never years ahead or before 2014", () => {
    const today = "2026-11-12";
    assert.equal(isSyncableDate("2026-11-12", today), true);
    assert.equal(isSyncableDate("2026-11-13", today), true);
    assert.equal(isSyncableDate("2026-11-14", today), false);
    assert.equal(isSyncableDate("2099-01-01", today), false);
    assert.equal(isSyncableDate("2013-12-31", today), false);
    assert.equal(isSyncableDate("2026-10-14", today), true);
    assert.equal(isSyncableDate("2026-02-30", today), false);
});

test("the server's today is its local date, not the UTC date", () => {
    // 1:00 on 12 Nov in India is still 11 Nov in UTC.
    const lateNight = new Date(2026, 10, 12, 1, 0, 0);
    assert.equal(localDateKey(lateNight), "2026-11-12");
    assert.equal(addDays("2026-11-12", -6), "2026-11-06");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("stored JSON blobs are bounded and shaped", () => {
    const hourly = [{ hour: 7, steps: 320, heartRate: 70 }];
    assert.equal(boundedJson(hourly, 16_000, { array: true }), JSON.stringify(hourly));
    assert.equal(boundedJson(JSON.stringify(hourly), 16_000, { array: true }), JSON.stringify(hourly));
    assert.equal(boundedJson([], 16_000, { array: true }), null);
    assert.equal(boundedJson({ hour: 1 }, 16_000, { array: true }), null);
    assert.equal(boundedJson("not json", 16_000), null);
    assert.equal(boundedJson(42, 16_000), null);
    assert.equal(boundedJson(Array.from({ length: 5000 }, (_, i) => ({ hour: i })), 16_000, { array: true }), null);
    assert.equal(boundedJson({ sources: ["Fitbit"] }, 4_000), '{"sources":["Fitbit"]}');
});

test("duplicate key errors are recognised in every shape TypeORM gives them", () => {
    assert.equal(isDuplicateKeyError({ number: 2627 }), true);
    assert.equal(isDuplicateKeyError({ driverError: { number: 2601 } }), true);
    assert.equal(isDuplicateKeyError({ originalError: { info: { number: 2627 } } }), true);
    assert.equal(isDuplicateKeyError({ number: 245 }), false);
    assert.equal(isDuplicateKeyError(new Error("boom")), false);
});

test("patient ids must be GUIDs", () => {
    assert.equal(isGuid("3F2504E0-4F89-11D3-9A0C-0305E82C3301"), true);
    assert.equal(isGuid("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), true);
    assert.equal(isGuid("abc"), false);
    assert.equal(isGuid("' OR 1=1 --"), false);
    assert.equal(isGuid(undefined), false);
});
