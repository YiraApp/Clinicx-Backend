import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import {
    CURVE, HieCryptoError, checksum, decodePublicKey, decrypt, encrypt, generateKeyMaterial, montgomeryToWeierstrassX, sharedSecretX,
} from "./hie-crypto.js";

const P = CURVE.p;
const mod = (x: bigint) => ((x % P) + P) % P;
const inv = (x: bigint) => {
    let r = 1n, b = mod(x), e = P - 2n;
    while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
    return r;
};

// An independent peer that does what BouncyCastle does: affine double-and-add on the short
// Weierstrass curve, with an unclamped scalar. It shares no code with the X25519 path.
type Point = { x: bigint; y: bigint } | null;
const add = (p1: Point, p2: Point): Point => {
    if (!p1) return p2;
    if (!p2) return p1;
    if (p1.x === p2.x && mod(p1.y + p2.y) === 0n) return null;
    const m = p1.x === p2.x
        ? mod((3n * p1.x * p1.x + CURVE.a) * inv(2n * p1.y))
        : mod((p2.y - p1.y) * inv(p2.x - p1.x));
    const x = mod(m * m - p1.x - p2.x);
    return { x, y: mod(m * (p1.x - x) - p1.y) };
};
const multiply = (k: bigint, point: Point): Point => {
    let result: Point = null, addend = point;
    for (let e = k; e > 0n; e >>= 1n) {
        if (e & 1n) result = add(result, addend);
        addend = add(addend, addend);
    }
    return result;
};
const BC_GY = BigInt("0x20AE19A1B8A086B4E01EDD2C7748D14C923D4D7E6D7C61B229E9C5A27ECED3D9");
const G: Point = { x: CURVE.gx, y: BC_GY };
const N = BigInt("0x1000000000000000000000000000000014DEF9DEA2F79CD65812631A5CF5D3ED");

/** A BouncyCastle-style peer's public key, SPKI with explicit parameters as some HIUs send it. */
const peerKey = (d: bigint) => {
    const q = multiply(d, G)!;
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(q.x.toString(16).padStart(64, "0"), "hex"), Buffer.from(q.y.toString(16).padStart(64, "0"), "hex")]);
    // A different, longer prefix than ours: the decoder must read only the trailing 65 bytes.
    return { q, spki: Buffer.concat([Buffer.from("3082013130" + "81ea0607", "hex"), randomBytes(180), point]).toString("base64") };
};
const pointOf = (spki: string) => {
    const bytes = Buffer.from(spki, "base64");
    const pt = bytes.subarray(bytes.length - 65);
    return { x: BigInt("0x" + pt.subarray(1, 33).toString("hex")), y: BigInt("0x" + pt.subarray(33).toString("hex")) };
};

test("the Weierstrass form matches BouncyCastle's Curve25519: its generator lies on the converted curve", () => {
    assert.equal(CURVE.b, BigInt("0x7B425ED097B425ED097B425ED097B425ED097B425ED097B4260B5E9C7710C864"));
    assert.equal(mod(BC_GY * BC_GY), mod(CURVE.gx ** 3n + CURVE.a * CURVE.gx + CURVE.b));
    assert.equal(montgomeryToWeierstrassX(9n), CURVE.gx, "Montgomery u = 9 is the generator");
    assert.equal(multiply(N, G), null, "the generator has the published order");
});

test("our shared secret equals the one a BouncyCastle-style peer computes", () => {
    for (let i = 0; i < 3; i++) {
        const ours = generateKeyMaterial();
        const d = BigInt("0x" + randomBytes(32).toString("hex")) % N;
        const peer = peerKey(d);

        const fromOurSide = sharedSecretX(ours.privateKey, peer.spki);
        const fromPeerSide = multiply(d, pointOf(ours.publicKey))!.x;
        assert.equal(fromOurSide.toString("hex"), fromPeerSide.toString(16).padStart(64, "0"));
        assert.equal(fromOurSide.length, 32);
    }
});

test("our public key is SPKI around an uncompressed point that is on the curve", () => {
    const { publicKey } = generateKeyMaterial();
    const bytes = Buffer.from(publicKey, "base64");
    assert.equal(bytes[0], 0x30);
    assert.equal(bytes[1], bytes.length - 2, "outer length");
    assert.ok(bytes.includes(Buffer.from("2a8648ce3d0201", "hex")), "id-ecPublicKey");
    assert.ok(bytes.includes(Buffer.from("2b0601040197550105 01".replace(" ", ""), "hex")), "curve25519 OID");
    const { x, y } = pointOf(publicKey);
    assert.equal(mod(y * y), mod(x ** 3n + CURVE.a * x + CURVE.b));
    assert.doesNotThrow(() => decodePublicKey(publicKey));
});

test("a record round-trips between HIP and HIU, and any wrong input fails the tag", () => {
    const hip = generateKeyMaterial();
    const hiu = generateKeyMaterial();
    const record = JSON.stringify({ resourceType: "Bundle", type: "document", note: "नमस्ते, ok" });

    const content = encrypt(record, hip, { publicKey: hiu.publicKey, nonce: hiu.nonce });
    assert.equal(decrypt(content, hiu, { publicKey: hip.publicKey, nonce: hip.nonce }), record);

    const other = generateKeyMaterial();
    assert.throws(() => decrypt(content, hiu, { publicKey: other.publicKey, nonce: hip.nonce }), "another key");
    assert.throws(() => decrypt(content, hiu, { publicKey: hip.publicKey, nonce: other.nonce }), "another nonce");
    const tampered = Buffer.from(content, "base64");
    tampered[0] ^= 1;
    assert.throws(() => decrypt(tampered.toString("base64"), hiu, { publicKey: hip.publicKey, nonce: hip.nonce }), "a changed byte");
});

test("the session key and IV come from the XOR of the nonces, split 20 and 12", async () => {
    const { createDecipheriv, hkdfSync } = await import("crypto");
    const hip = generateKeyMaterial();
    const hiu = generateKeyMaterial();
    const content = encrypt("record", hip, { publicKey: hiu.publicKey, nonce: hiu.nonce });

    // Rebuild the key by hand from the scheme as ABDM documents it.
    const a = Buffer.from(hip.nonce, "base64"), b = Buffer.from(hiu.nonce, "base64");
    const xor = Buffer.from(a.map((v, i) => v ^ b[i]!));
    const key = Buffer.from(hkdfSync("sha256", sharedSecretX(hiu.privateKey, hip.publicKey), xor.subarray(0, 20), Buffer.alloc(0), 32));
    const data = Buffer.from(content, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, xor.subarray(20));
    decipher.setAuthTag(data.subarray(data.length - 16));
    assert.equal(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString(), "record");
});

test("bad keys and nonces are refused with a reason", () => {
    const hip = generateKeyMaterial();
    assert.throws(() => decodePublicKey(Buffer.alloc(20).toString("base64")), HieCryptoError);
    const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(32, 1), Buffer.alloc(32, 2)]).toString("base64");
    assert.throws(() => decodePublicKey(offCurve), /not on Curve25519/);
    assert.throws(() => encrypt("x", hip, { publicKey: hip.publicKey, nonce: Buffer.alloc(16).toString("base64") }), /32 bytes/);
});

test("each key material is fresh", () => {
    const a = generateKeyMaterial(), b = generateKeyMaterial();
    assert.notEqual(a.publicKey, b.publicKey);
    assert.notEqual(a.nonce, b.nonce);
    assert.equal(Buffer.from(a.nonce, "base64").length, 32);
    assert.equal(checksum("abc"), "900150983cd24fb0d6963f7d28e17f72");
});
