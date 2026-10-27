import { test } from "node:test";
import assert from "node:assert/strict";
import {
    ABHA_ADDRESS_PATTERN,
    CONSENT_STATUSES,
    HIU_ACCESS_MODES,
    HIU_FREQUENCY_UNITS,
    HIU_HI_TYPES,
    HIU_PURPOSES,
    HiuError,
    hiTypeLabel,
    hiuFacilityNotConfiguredError,
    hiuNotConfiguredError,
    isAbhaAddress,
    isAccessMode,
    isDataPushUrl,
    isDateOnly,
    isFrequencyUnit,
    isHiType,
    isPurposeCode,
    parseDateTime,
    parseHiTypes,
    purposeText,
} from "./hiu-enums.js";

test("the six purposes carry exactly the text the spec pairs with each code", () => {
    assert.deepEqual(
        HIU_PURPOSES.map((purpose) => [purpose.code, purpose.text]),
        [
            ["CAREMGT", "Care Management"],
            ["BTG", "Break the Glass"],
            ["PUBHLTH", "Public Health"],
            ["HPAYMT", "Healthcare Payment"],
            ["DSRCH", "Disease Specific Healthcare Research"],
            ["PATRQT", "Self Requested"],
        ],
    );
    assert.equal(purposeText("DSRCH"), "Disease Specific Healthcare Research");
    assert.equal(purposeText("caremgt"), null, "codes are case-sensitive");
    assert.ok(isPurposeCode("PATRQT"));
    assert.ok(!isPurposeCode("Care Management"));
    assert.ok(!isPurposeCode(undefined));
});

test("the eight HI types, access modes and frequency units are the spec's enums", () => {
    assert.deepEqual(
        HIU_HI_TYPES.map((type) => type.code).sort(),
        ["DiagnosticReport", "DischargeSummary", "HealthDocumentRecord", "ImmunizationRecord", "Invoice", "OPConsultation", "Prescription", "WellnessRecord"],
    );
    assert.ok(HIU_HI_TYPES.every((type) => type.label.length > 0));
    assert.equal(hiTypeLabel("OPConsultation"), "OP consultation");
    assert.ok(isHiType("Invoice"));
    assert.ok(!isHiType("invoice"));
    assert.deepEqual([...HIU_ACCESS_MODES], ["VIEW", "STORE", "STREAM", "QUERY"]);
    assert.ok(isAccessMode("VIEW") && !isAccessMode("view") && !isAccessMode("READ"));
    assert.deepEqual([...HIU_FREQUENCY_UNITS], ["HOUR", "DAY", "WEEK", "MONTH", "YEAR"]);
    assert.ok(isFrequencyUnit("HOUR") && !isFrequencyUnit("MINUTE"));
    assert.deepEqual([...CONSENT_STATUSES], ["SENDING", "REQUESTED", "GRANTED", "PARTLY_REVOKED", "DENIED", "EXPIRED", "REVOKED", "FAILED"]);
});

test("HI type lists need at least one known type and no repeats", () => {
    assert.deepEqual(parseHiTypes(["Prescription", "Invoice"]), ["Prescription", "Invoice"]);
    assert.equal(parseHiTypes([]), null);
    assert.equal(parseHiTypes(["Prescription", "Prescription"]), null);
    assert.equal(parseHiTypes(["Prescription", "XRay"]), null);
    assert.equal(parseHiTypes("Prescription"), null);
});

test("ABHA addresses follow the spec pattern for patient.id", () => {
    for (const ok of ["ravi.kumar@sbx", "ravi_k1@abdm", "a1b@sbx", "x-y!z@sbx"]) assert.ok(isAbhaAddress(ok), ok);
    for (const bad of ["ravi@ndhm", "ravi.kumar", ".ravi@sbx", "ravi.@sbx", "ab@sbx", "ravi kumar@sbx", "91-1234-5678-9012", 42]) {
        assert.ok(!isAbhaAddress(bad), String(bad));
    }
    assert.ok(isAbhaAddress("ravi@sbx", "@sbx"));
    assert.ok(!isAbhaAddress("ravi@abdm", "@sbx"), "an address from another environment is refused");
    assert.equal(ABHA_ADDRESS_PATTERN.source, "^[a-zA-Z0-9][a-zA-Z0-9_.\\-!]+[a-zA-Z0-9]@(abdm|sbx)$");
});

test("dates and date-times are checked, never guessed", () => {
    assert.ok(isDateOnly("2024-02-29"));
    assert.ok(!isDateOnly("2026-02-30"));
    assert.ok(!isDateOnly("2026-1-05"));
    assert.ok(!isDateOnly("2026-01-05T00:00:00Z"));
    assert.equal(parseDateTime("2026-11-01T10:00:00.000Z")?.toISOString(), "2026-11-01T10:00:00.000Z");
    assert.equal(parseDateTime("2026-11-01T15:30+05:30")?.toISOString(), "2026-11-01T10:00:00.000Z");
    assert.equal(parseDateTime("2026-11-01T10:00:00"), null, "a time without a zone is refused");
    assert.equal(parseDateTime("tomorrow"), null);
});

test("a dataPushUrl must fit ABDM's 255-character rule", () => {
    assert.ok(isDataPushUrl(`https://example.ngrok-free.dev/api/v3/hiu/data-push/${"a".repeat(64)}`));
    assert.ok(!isDataPushUrl(`https://example.dev/${"a".repeat(250)}`));
    assert.ok(!isDataPushUrl("https://example.dev/push#x"));
    assert.ok(!isDataPushUrl(""));
});

test("HiuError carries status, kind and details, and never the word the frontend reads as a lapsed login", () => {
    const error = new HiuError("conflict", "An open request already exists.", { details: { id: 7 } });
    assert.ok(error instanceof Error);
    assert.equal(error.status, 409);
    assert.equal(error.kind, "conflict");
    assert.deepEqual(error.details, { id: 7 });
    assert.equal(new HiuError("validation", "x").status, 400);
    assert.equal(new HiuError("forbidden", "x").status, 403);
    assert.equal(new HiuError("not-found", "x").status, 404);
    assert.equal(new HiuError("abdm", "x").status, 422);
    assert.equal(new HiuError("abdm", "x", { status: 502 }).status, 502);
    assert.ok(!/expired/i.test(new HiuError("validation", "The consent has Expired.").message));
    const notConfigured = hiuNotConfiguredError();
    assert.equal(notConfigured.status, 503);
    assert.equal(notConfigured.kind, "not-configured");
    const facilityNotConfigured = hiuFacilityNotConfiguredError();
    assert.equal(facilityNotConfigured.status, 503);
    assert.equal(facilityNotConfigured.kind, "not-configured");
    assert.match(facilityNotConfigured.message, /hospital isn't set up as an ABDM HIU facility/);
    for (const error of [notConfigured, facilityNotConfigured]) assert.doesNotMatch(error.message, /expired/i);
});
