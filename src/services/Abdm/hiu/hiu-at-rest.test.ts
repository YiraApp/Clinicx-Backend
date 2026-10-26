import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import { HiuAtRestError, atRestKeysFrom, atRestKeysFromConfig, open, seal, type AtRestKeys } from "./hiu-at-rest.js";

const keyText = () => randomBytes(32).toString("base64");
const keysOf = (key = keyText(), keyId?: string): AtRestKeys => atRestKeysFrom({ key, keyId })!;
const isReason = (reason: string) => (error: unknown) => error instanceof HiuAtRestError && error.reason === reason;

test("seal and open round trip strings and bytes, with a fresh IV each time", () => {
    const keys = keysOf();
    const a = seal("private key or record", keys);
    const b = seal("private key or record", keys);
    assert.notEqual(a, b);
    assert.equal(open(a, keys).toString("utf8"), "private key or record");
    const bytes = randomBytes(5000);
    assert.deepEqual(open(seal(bytes, keys), keys), bytes);
    assert.deepEqual(open(seal(Buffer.alloc(0), keys), keys), Buffer.alloc(0));
});

test("the sealed value is self-describing and carries no plaintext", () => {
    const keys = keysOf(undefined, "k7");
    const sealed = seal("hello world", keys);
    const [version, keyId, iv, body] = sealed.split(":");
    assert.equal(version, "hiu1");
    assert.equal(keyId, "k7");
    assert.equal(Buffer.from(iv, "base64").length, 12);
    assert.equal(Buffer.from(body, "base64").length, "hello world".length + 16);
    assert.ok(!sealed.includes("hello"));
});

test("open refuses tampering with the body, the IV, the key id or the version", () => {
    const keys = keysOf();
    const sealed = seal("record", keys);
    const [version, keyId, iv, body] = sealed.split(":");
    const flip = (text: string, index: number) => {
        const bytes = Buffer.from(text, "base64");
        bytes[index] ^= 1;
        return bytes.toString("base64");
    };
    assert.throws(() => open([version, keyId, iv, flip(body, 0)].join(":"), keys), isReason("tampered"));
    assert.throws(() => open([version, keyId, iv, flip(body, Buffer.from(body, "base64").length - 1)].join(":"), keys), isReason("tampered"));
    assert.throws(() => open([version, keyId, flip(iv, 0), body].join(":"), keys), isReason("tampered"));

    // The same key under another id: the id is authenticated, so a relabelled value fails.
    const relabelled: AtRestKeys = { currentId: "k1", keys: new Map([["k1", keys.keys.get("k1")!], ["k2", keys.keys.get("k1")!]]) };
    assert.throws(() => open(["hiu1", "k2", iv, body].join(":"), relabelled), isReason("tampered"));
    assert.throws(() => open(["hiu2", keyId, iv, body].join(":"), keys), isReason("malformed"));
});

test("open refuses unknown key ids, other keys and malformed input", () => {
    const keys = keysOf();
    const sealed = seal("record", keys);
    assert.throws(() => open(sealed, keysOf(undefined, "k2")), isReason("unknown-key"));
    assert.throws(() => open(sealed, keysOf()), isReason("tampered"), "same id, different key");
    for (const bad of ["", "record", "hiu1:k1:abc", "hiu1:k1:!!:!!", "hiu1:k 1:AAAA:AAAA", "hiu1:k1:AAAA:AAAA"]) {
        assert.throws(() => open(bad, keys), isReason("malformed"), bad);
    }
    assert.throws(() => open(undefined as unknown as string, keys), isReason("malformed"));
});

test("a rotated key set opens values sealed under the previous key and seals with the current one", () => {
    const old = keysOf(undefined, "k1");
    const sealedOld = seal("old row", old);
    const next = keysOf(undefined, "k2");
    const rotated: AtRestKeys = { currentId: "k2", keys: new Map([...old.keys, ...next.keys]) };
    assert.equal(open(sealedOld, rotated).toString("utf8"), "old row");
    assert.equal(seal("new row", rotated).split(":")[1], "k2");
});

test("key settings: 32 bytes of base64 required, id defaults to k1", () => {
    const key = keyText();
    assert.equal(atRestKeysFrom({ key, keyId: undefined })!.currentId, "k1");
    assert.equal(atRestKeysFrom({ key, keyId: "  " })!.currentId, "k1");
    assert.equal(atRestKeysFrom({ key: ` ${key} `, keyId: "2026-10" })!.currentId, "2026-10");
    assert.equal(atRestKeysFrom({ key: undefined, keyId: "k1" }), null);
    assert.equal(atRestKeysFrom({ key: "", keyId: "k1" }), null);
    assert.equal(atRestKeysFrom({ key: randomBytes(16).toString("base64"), keyId: "k1" }), null);
    assert.equal(atRestKeysFrom({ key: randomBytes(32).toString("hex"), keyId: "k1" }), null);
    assert.equal(atRestKeysFrom({ key, keyId: "bad:id" }), null, "the separator cannot appear in an id");
});

test("atRestKeysFromConfig reads ABDM_HIU_DATA_KEY and ABDM_HIU_DATA_KEY_ID", () => {
    const saved = { key: process.env.ABDM_HIU_DATA_KEY, id: process.env.ABDM_HIU_DATA_KEY_ID };
    try {
        delete process.env.ABDM_HIU_DATA_KEY;
        delete process.env.ABDM_HIU_DATA_KEY_ID;
        assert.equal(atRestKeysFromConfig(), null);
        process.env.ABDM_HIU_DATA_KEY = randomBytes(31).toString("base64");
        assert.equal(atRestKeysFromConfig(), null);
        process.env.ABDM_HIU_DATA_KEY = keyText();
        assert.equal(atRestKeysFromConfig()!.currentId, "k1");
        process.env.ABDM_HIU_DATA_KEY_ID = "k9";
        const keys = atRestKeysFromConfig()!;
        assert.equal(keys.currentId, "k9");
        assert.equal(keys.keys.get("k9")!.length, 32);
    } finally {
        if (saved.key === undefined) delete process.env.ABDM_HIU_DATA_KEY;
        else process.env.ABDM_HIU_DATA_KEY = saved.key;
        if (saved.id === undefined) delete process.env.ABDM_HIU_DATA_KEY_ID;
        else process.env.ABDM_HIU_DATA_KEY_ID = saved.id;
    }
});

test("a multi-megabyte record seals and opens, and key ids are limited to 32 safe characters", () => {
    const keys = keysOf();
    const record = randomBytes(12 * 1024 * 1024);
    assert.ok(open(seal(record, keys), keys).equals(record));
    const key = keyText();
    assert.equal(atRestKeysFrom({ key, keyId: "a".repeat(32) })!.currentId, "a".repeat(32));
    assert.equal(atRestKeysFrom({ key, keyId: "a".repeat(33) }), null);
    assert.equal(atRestKeysFrom({ key, keyId: "key 1" }), null);
    // A key whose base64 is unpadded or base64url is refused, so it can never decode differently.
    assert.equal(atRestKeysFrom({ key: key.replace(/=+$/, ""), keyId: "k1" }), null);
    // seal() refuses a hand-built key set whose current id has no key.
    assert.throws(() => seal("x", { currentId: "k2", keys: keys.keys }), isReason("unknown-key"));
});

test("errors carry no value and never say expired", () => {
    const keys = keysOf();
    try {
        open(`hiu1:k1:${randomBytes(12).toString("base64")}:${Buffer.from("secret-record-text-and-tag!!").toString("base64")}`, keys);
        assert.fail("should not open");
    } catch (error) {
        assert.ok(!(error as Error).message.includes("secret"));
        assert.ok(!/expired/i.test((error as Error).message));
    }
});
