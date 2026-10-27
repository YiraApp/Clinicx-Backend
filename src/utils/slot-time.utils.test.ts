import { test } from "node:test";
import assert from "node:assert/strict";
import { slotClosed, slotMinutes } from "./slot-time.utils.js";

// 27 Oct 2026, 14:05 server time
const NOW = new Date(2026, 9, 27, 14, 5);
const slot = (StartTime: string, EndTime: string | null, SlotDate: Date | string = "2026-10-27") => ({ SlotDate, StartTime, EndTime });

test("slot times read in 24-hour and 12-hour forms", () => {
    assert.equal(slotMinutes("14:15"), 855);
    assert.equal(slotMinutes("14:15:00"), 855);
    assert.equal(slotMinutes("2:15 PM"), 855);
    assert.equal(slotMinutes("12:00 AM"), 0);
    assert.equal(slotMinutes("12:30 PM"), 750);
    assert.equal(slotMinutes(""), null);
    assert.equal(slotMinutes(null), null);
});

test("a slot under way can still be booked; one that has ended can't", () => {
    assert.equal(slotClosed(slot("14:00:00", "14:15:00"), NOW), null, "14:00–14:15 at 14:05 is in progress");
    assert.equal(slotClosed(slot("2:00 PM", "2:15 PM"), NOW), null, "the same in 12-hour times");
    assert.equal(slotClosed(slot("14:15:00", "14:30:00"), NOW), null, "a later slot");
    assert.equal(slotClosed(slot("13:45:00", "14:00:00"), NOW), "time", "ended at 14:00");
    assert.equal(slotClosed(slot("13:50:00", "14:05:00"), NOW), "time", "ends this minute");
});

test("a slot without an end time closes when it starts", () => {
    assert.equal(slotClosed(slot("14:00:00", null), NOW), "time");
    assert.equal(slotClosed(slot("14:10:00", null), NOW), null);
});

test("past days are closed and later days open, whatever the time", () => {
    assert.equal(slotClosed(slot("23:00:00", "23:15:00", "2026-10-26"), NOW), "date");
    assert.equal(slotClosed(slot("09:00:00", "09:15:00", "2026-10-28T00:00:00.000Z"), NOW), null);
    assert.equal(slotClosed(slot("14:00:00", "14:15:00", new Date("2026-10-27T00:00:00.000Z")), NOW), null, "a SQL date column read as a Date");
});
