import { test } from "node:test";
import assert from "node:assert/strict";
import { abhaPatientCondition, parseAbhaPatientFilter } from "./abha-filter.utils.js";

test("only the two known values become a filter", () => {
    assert.equal(parseAbhaPatientFilter("registered"), "registered");
    assert.equal(parseAbhaPatientFilter("not-registered"), "not-registered");
    for (const other of [undefined, "", "all", "1", "registered OR 1=1", ["registered"]]) {
        assert.equal(parseAbhaPatientFilter(other), undefined, String(other));
    }
});

test("each filter is a fixed condition on the users alias", () => {
    assert.equal(abhaPatientCondition("registered", "u"), "u.RegisteredViaAbha = 1");
    assert.equal(abhaPatientCondition("not-registered", "u"), "u.RegisteredViaAbha = 0");
    assert.equal(abhaPatientCondition(undefined, "u"), null);
});
