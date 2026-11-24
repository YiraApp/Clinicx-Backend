import { test } from "node:test";
import assert from "node:assert/strict";
import {
    FilterError,
    bucketStart,
    bucketsBetween,
    containsPattern,
    dashboardRange,
    parseCeoDashboardQuery,
    statusLabel,
    todayInIndia,
} from "./ceo-dashboard.filters.js";

const TODAY = "2026-11-10";

test("with no query: the last 30 days in day buckets, no other filters", () => {
    const f = parseCeoDashboardQuery({}, TODAY);
    assert.equal(f.from, "2026-10-12");
    assert.equal(f.to, TODAY);
    assert.equal(f.granularity, "day");
    assert.deepEqual(f.roleIds, []);
    assert.equal(f.organizationId, null);
    assert.equal(f.disease, null);
});

test("filters are read, trimmed and normalised", () => {
    const f = parseCeoDashboardQuery({
        from: "2026-01-01", to: "2026-06-30", granularity: "week",
        roleIds: "fe80173f-9db3-4703-84a8-5c23e7cc493c, 4FC67429-28AE-4106-93EF-436228282ED0",
        organizationId: "12", hospitalId: "all", gender: "female", ageBand: "60+",
        state: "  Telangana ", city: "", pincode: "500081", specialty: "Cardiology", disease: "diabetes",
    }, TODAY);
    assert.deepEqual(f.roleIds, ["FE80173F-9DB3-4703-84A8-5C23E7CC493C", "4FC67429-28AE-4106-93EF-436228282ED0"]);
    assert.equal(f.organizationId, 12);
    assert.equal(f.hospitalId, null);
    assert.equal(f.gender, "Female");
    assert.equal(f.ageBand, "60+");
    assert.equal(f.state, "Telangana");
    assert.equal(f.city, null);
    assert.equal(f.granularity, "week");
});

test("repeated roleIds parameters are accepted", () => {
    const f = parseCeoDashboardQuery({ roleIds: ["fe80173f-9db3-4703-84a8-5c23e7cc493c", "fe80173f-9db3-4703-84a8-5c23e7cc493c"] }, TODAY);
    assert.deepEqual(f.roleIds, ["FE80173F-9DB3-4703-84A8-5C23E7CC493C"]);
});

test("bad input is refused with a message", () => {
    const bad: Record<string, unknown>[] = [
        { from: "2026-02-30" },
        { from: "10/11/2026" },
        { from: "2026-11-11", to: "2026-11-10" },
        { from: "2000-01-01", to: "2026-01-01" },
        { granularity: "hour" },
        { roleIds: "1; DROP TABLE Users" },
        { organizationId: "-1" },
        { hospitalId: "abc" },
        { gender: "x" },
        { ageBand: "20-25" },
        { disease: "x".repeat(101) },
    ];
    for (const query of bad) assert.throws(() => parseCeoDashboardQuery(query, TODAY), FilterError, JSON.stringify(query));
});

test("too many day or week buckets step up to a coarser size", () => {
    assert.equal(parseCeoDashboardQuery({ from: "2026-01-01", to: "2026-11-10", granularity: "day" }, TODAY).granularity, "week");
    assert.equal(parseCeoDashboardQuery({ from: "2022-01-01", to: "2026-11-10", granularity: "week" }, TODAY).granularity, "month");
    assert.equal(parseCeoDashboardQuery({ from: "2026-01-01", to: "2026-11-10" }, TODAY).granularity, "month");
});

test("weeks start on Monday and months on the 1st", () => {
    assert.equal(bucketStart("2026-11-10", "week"), "2026-11-09"); // Tuesday → Monday
    assert.equal(bucketStart("2026-11-09", "week"), "2026-11-09");
    assert.equal(bucketStart("2026-11-15", "week"), "2026-11-09"); // Sunday
    assert.equal(bucketStart("2026-11-10", "month"), "2026-11-01");
    assert.deepEqual(bucketsBetween("2026-10-30", "2026-11-02", "day"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    assert.deepEqual(bucketsBetween("2026-11-01", "2026-11-17", "week"), ["2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16"]);
    assert.deepEqual(bucketsBetween("2025-12-15", "2026-02-01", "month"), ["2025-12-01", "2026-01-01", "2026-02-01"]);
});

test("the comparison period is the same length, just before", () => {
    const r = dashboardRange({ from: "2026-11-01", to: "2026-11-10", granularity: "day" });
    assert.equal(r.previousFrom, "2026-10-22");
    assert.equal(r.previousTo, "2026-10-31");
    assert.equal(r.buckets.length, 10);
});

test("LIKE wildcards in a disease search are escaped", () => {
    assert.equal(containsPattern("diabetes"), "%diabetes%");
    assert.equal(containsPattern("50%_[a]\\"), "%50\\%\\_\\[a]\\\\%");
});

test("status labels read naturally", () => {
    assert.equal(statusLabel("PaymentPending"), "Payment pending");
    assert.equal(statusLabel("in-progress"), "In progress");
    assert.equal(statusLabel("confirmed"), "Confirmed");
    assert.equal(statusLabel(""), "Unknown");
});

test("today is taken in India time", () => {
    assert.equal(todayInIndia(new Date("2026-11-10T19:00:00Z")), "2026-11-11");
    assert.equal(todayInIndia(new Date("2026-11-10T18:00:00Z")), "2026-11-10");
});
