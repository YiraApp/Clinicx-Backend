import { test } from "node:test";
import assert from "node:assert/strict";
import { toInternationalPhone } from "./phone-number.js";

test("Indian numbers get 91 as before", () => {
    assert.equal(toInternationalPhone("9876543210", "91"), "919876543210");
    assert.equal(toInternationalPhone("9876543210", null), "919876543210");
    assert.equal(toInternationalPhone("98765 43210", "+91"), "919876543210");
    // A 10-digit number that starts with 91 is still a national number.
    assert.equal(toInternationalPhone("9123456789", "91"), "919123456789");
});

test("numbers that are not 10 digits get their own country code", () => {
    // Australian mobile, saved as 9 digits: was sent without any code.
    assert.equal(toInternationalPhone("449679321", "61"), "61449679321");
    assert.equal(toInternationalPhone("0449 679 321", "61"), "61449679321");
    // UAE number saved with its trunk 0.
    assert.equal(toInternationalPhone("0551234567", "971"), "971551234567");
    assert.equal(toInternationalPhone("4085551234", "1"), "14085551234");
});

test("a code already in front is not added twice", () => {
    assert.equal(toInternationalPhone("919876543210", "91"), "919876543210");
    assert.equal(toInternationalPhone("61449679321", "61"), "61449679321");
    assert.equal(toInternationalPhone("+61 449 679 321", "91"), "61449679321");
    assert.equal(toInternationalPhone("0061449679321", "91"), "61449679321");
});

test("no number gives an empty string", () => {
    assert.equal(toInternationalPhone("", "61"), "");
    assert.equal(toInternationalPhone(null, "61"), "");
    assert.equal(toInternationalPhone(undefined), "");
});
