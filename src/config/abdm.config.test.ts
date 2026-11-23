import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { abdmConfig } from "./abdm.config.js";

const HIU_SETTINGS = [
    "ABDM_HIU_ID",
    "ABDM_HIU_NAME",
    "ABDM_HIP_NAME",
    "ABDM_DATA_PUSH_BASE_URL",
    "ABDM_DATA_PUSH_MAX_MB",
    "ABDM_DATA_PUSH_MAX_TRANSFER_MB",
    "ABDM_DATA_PUSH_TOKEN_GRACE_MINUTES",
    "ABDM_HIU_KEY_FORMAT",
    "ABDM_HIU_SPKI_KEY_HIPS",
    "ABDM_HIU_DATA_KEY",
    "ABDM_HIU_DATA_KEY_ID",
    "ABDM_HIU_ROLE_NAMES",
    "ABDM_HIU_TRANSFER_WINDOW_MINUTES",
    "ABDM_HIP_ID",
];
let saved: Record<string, string | undefined>;
const KEY = Buffer.alloc(32, 7).toString("base64");

beforeEach(() => {
    saved = Object.fromEntries(HIU_SETTINGS.map((name) => [name, process.env[name]]));
    for (const name of HIU_SETTINGS) delete process.env[name];
});

afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

test("HIU settings default as the contract says", () => {
    process.env.ABDM_HIP_ID = "IN0000000000";
    assert.equal(abdmConfig.hiuId, "", "never falls back to the HIP id");
    assert.equal(abdmConfig.hiuName, "");
    assert.equal(abdmConfig.dataPushBaseUrl, "");
    assert.equal(abdmConfig.dataPushMaxMb, 20);
    assert.equal(abdmConfig.dataPushMaxTransferMb, 100);
    assert.equal(abdmConfig.dataPushTokenGraceMinutes, 60);
    assert.equal(abdmConfig.hiuDataKey, "");
    assert.equal(abdmConfig.hiuDataKeyId, "k1");
    assert.deepEqual(abdmConfig.hiuRoleNames, ["Provider", "Hospital Admin"]);
    assert.equal(abdmConfig.hiuTransferWindowMinutes, 20);
    assert.equal(abdmConfig.hiuKeyFormat, "point", "the bare point, as the PHR app sends it");
    assert.equal(abdmConfig.hiuConfigured, false, "no records key");
});

test("the HIU key format is 'spki' only when asked for, in any case; anything else is the bare point", () => {
    process.env.ABDM_HIU_KEY_FORMAT = "SPKI";
    assert.equal(abdmConfig.hiuKeyFormat, "spki");
    process.env.ABDM_HIU_KEY_FORMAT = "x509";
    assert.equal(abdmConfig.hiuKeyFormat, "point");
});

test("a HIP listed in ABDM_HIU_SPKI_KEY_HIPS gets spki, any other HIP the deployment's format", () => {
    assert.deepEqual(abdmConfig.hiuSpkiKeyHips, []);
    assert.equal(abdmConfig.hiuKeyFormatFor("IN2410002641"), "point");
    process.env.ABDM_HIU_SPKI_KEY_HIPS = " IN2410002641 , in0910034358,, ";
    assert.deepEqual(abdmConfig.hiuSpkiKeyHips, ["IN2410002641", "in0910034358"]);
    assert.equal(abdmConfig.hiuKeyFormatFor("IN2410002641"), "spki");
    assert.equal(abdmConfig.hiuKeyFormatFor(" IN0910034358 "), "spki", "matched without case or spaces");
    assert.equal(abdmConfig.hiuKeyFormatFor("IN3310002235"), "point");
    assert.equal(abdmConfig.hiuKeyFormatFor(null), "point");
    assert.equal(abdmConfig.hiuKeyFormatFor(""), "point");
    process.env.ABDM_HIU_KEY_FORMAT = "spki";
    assert.equal(abdmConfig.hiuKeyFormatFor("IN3310002235"), "spki", "the deployment's format for an unlisted HIP");
});

test("HIU settings are read and cleaned", () => {
    process.env.ABDM_HIP_NAME = "A A Hospital";
    assert.equal(abdmConfig.hiuName, "A A Hospital", "the HIU name defaults to the HIP name");
    process.env.ABDM_HIU_NAME = " Clinic HIU ";
    assert.equal(abdmConfig.hiuName, "Clinic HIU");
    process.env.ABDM_DATA_PUSH_BASE_URL = "https://example.ngrok-free.dev//";
    assert.equal(abdmConfig.dataPushBaseUrl, "https://example.ngrok-free.dev");
    process.env.ABDM_DATA_PUSH_MAX_MB = "50";
    assert.equal(abdmConfig.dataPushMaxMb, 50);
    process.env.ABDM_DATA_PUSH_MAX_MB = "-1";
    assert.equal(abdmConfig.dataPushMaxMb, 20);
    process.env.ABDM_DATA_PUSH_MAX_TRANSFER_MB = "40";
    assert.equal(abdmConfig.dataPushMaxTransferMb, 40);
    process.env.ABDM_DATA_PUSH_MAX_TRANSFER_MB = "x";
    assert.equal(abdmConfig.dataPushMaxTransferMb, 100);
    process.env.ABDM_HIU_ROLE_NAMES = " provider , ,Org Admin";
    assert.deepEqual(abdmConfig.hiuRoleNames, ["provider", "Org Admin"]);
    process.env.ABDM_HIU_TRANSFER_WINDOW_MINUTES = "abc";
    assert.equal(abdmConfig.hiuTransferWindowMinutes, 20);
    process.env.ABDM_HIU_TRANSFER_WINDOW_MINUTES = "5";
    assert.equal(abdmConfig.hiuTransferWindowMinutes, 5);
    process.env.ABDM_HIU_DATA_KEY_ID = "k2";
    assert.equal(abdmConfig.hiuDataKeyId, "k2");
});

test("hiuConfigured needs a 32-byte key and a usable push address when one is set; not ABDM_HIU_ID", () => {
    delete process.env.ABDM_HIU_ID;
    process.env.ABDM_HIU_DATA_KEY = KEY;
    process.env.ABDM_DATA_PUSH_BASE_URL = "https://example.ngrok-free.dev";
    assert.equal(abdmConfig.hiuConfigured, true);

    process.env.ABDM_HIU_DATA_KEY = Buffer.alloc(16, 7).toString("base64");
    assert.equal(abdmConfig.hiuConfigured, false, "a 16-byte key is refused");
    process.env.ABDM_HIU_DATA_KEY = "not base64 at all!";
    assert.equal(abdmConfig.hiuConfigured, false);
    process.env.ABDM_HIU_DATA_KEY = KEY;

    process.env.ABDM_HIU_DATA_KEY_ID = "k:1";
    assert.equal(abdmConfig.hiuConfigured, false, "a key id the sealed format cannot carry is refused");
    process.env.ABDM_HIU_DATA_KEY_ID = "x".repeat(33);
    assert.equal(abdmConfig.hiuConfigured, false);
    process.env.ABDM_HIU_DATA_KEY_ID = "k2";
    assert.equal(abdmConfig.hiuConfigured, true);
    delete process.env.ABDM_HIU_DATA_KEY_ID;

    process.env.ABDM_HIU_ID = "IN3610001174";
    assert.equal(abdmConfig.hiuConfigured, true, "the legacy ABDM_HIU_ID plays no part");
    process.env.ABDM_DATA_PUSH_BASE_URL = "example.ngrok-free.dev";
    assert.equal(abdmConfig.hiuConfigured, false, "the push base needs a scheme");
    process.env.ABDM_DATA_PUSH_BASE_URL = "https://exa mple.dev";
    assert.equal(abdmConfig.hiuConfigured, false, "characters outside ABDM's dataPushUrl set are refused");
    process.env.ABDM_DATA_PUSH_BASE_URL = `https://${"a".repeat(170)}.dev`;
    assert.equal(abdmConfig.hiuConfigured, false, "a base too long for a 255-character dataPushUrl is refused");
    delete process.env.ABDM_DATA_PUSH_BASE_URL;
    assert.equal(abdmConfig.hiuConfigured, true, "unset, the bridge URL is the push address (checked where it is read)");
    delete process.env.ABDM_HIU_DATA_KEY;
    assert.equal(abdmConfig.hiuConfigured, false);
});

test("the data push token grace is read in minutes: 0 turns it off, junk or a negative falls back to 60, at most a day", () => {
    process.env.ABDM_DATA_PUSH_TOKEN_GRACE_MINUTES = "15";
    assert.equal(abdmConfig.dataPushTokenGraceMinutes, 15);
    process.env.ABDM_DATA_PUSH_TOKEN_GRACE_MINUTES = "0";
    assert.equal(abdmConfig.dataPushTokenGraceMinutes, 0);
    process.env.ABDM_DATA_PUSH_TOKEN_GRACE_MINUTES = "-5";
    assert.equal(abdmConfig.dataPushTokenGraceMinutes, 60);
    process.env.ABDM_DATA_PUSH_TOKEN_GRACE_MINUTES = "soon";
    assert.equal(abdmConfig.dataPushTokenGraceMinutes, 60);
    process.env.ABDM_DATA_PUSH_TOKEN_GRACE_MINUTES = "100000";
    assert.equal(abdmConfig.dataPushTokenGraceMinutes, 24 * 60);
});

test("a data push needs a gateway token only when ABDM_DATA_PUSH_REQUIRE_TOKEN says so", () => {
    const original = process.env.ABDM_DATA_PUSH_REQUIRE_TOKEN;
    try {
        delete process.env.ABDM_DATA_PUSH_REQUIRE_TOKEN;
        assert.equal(abdmConfig.dataPushRequiresToken, false, "off by default: the push address admits a push with no token");
        for (const value of ["true", "TRUE", "1", "yes"]) {
            process.env.ABDM_DATA_PUSH_REQUIRE_TOKEN = value;
            assert.equal(abdmConfig.dataPushRequiresToken, true, value);
        }
        for (const value of ["false", "0", "no", "maybe", ""]) {
            process.env.ABDM_DATA_PUSH_REQUIRE_TOKEN = value;
            assert.equal(abdmConfig.dataPushRequiresToken, false, value);
        }
    } finally {
        if (original === undefined) delete process.env.ABDM_DATA_PUSH_REQUIRE_TOKEN;
        else process.env.ABDM_DATA_PUSH_REQUIRE_TOKEN = original;
    }
});
