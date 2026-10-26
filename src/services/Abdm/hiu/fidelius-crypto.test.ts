import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes } from "crypto";
import { readFileSync } from "fs";
import {
    HiuCryptoError,
    KEY_MATERIAL_CRYPTO_ALG,
    KEY_MATERIAL_CURVE,
    KEY_MATERIAL_PARAMETERS,
    WEIERSTRASS_A,
    WEIERSTRASS_B,
    checksumOf,
    decryptEntry,
    encryptEntry,
    generateKeyMaterial,
    montgomeryUToWeierstrassX,
    parsePeerPublicKey,
    publicKeyValueOf,
    sharedSecretX,
    verifyChecksum,
} from "./fidelius-crypto.js";

// ---------------------------------------------------------------------------------------------
// An independent short-Weierstrass implementation, affine double-and-add in plain BigInt, with
// BouncyCastle's curve25519 parameters as BouncyCastle defines them
// (org.bouncycastle.math.ec.custom.djb.Curve25519 and CustomNamedCurves "curve25519"): the
// Montgomery curve v^2 = u^3 + 486662 u^2 + u moved to y^2 = x^3 + a x + b by x = u + A/3, so
// a = (3 - A^2)/3 and b = (2A^3 - 9A)/27 mod p; G is u = 9 shifted the same way; n is the prime
// order of G, cofactor 8. The hex below is BouncyCastle's own, also emitted by the BouncyCastle
// 1.79 generator into __fixtures__/fidelius-vectors.json and checked against it below.

const p = 2n ** 255n - 19n;
const BC = {
    a: 0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa984914a144n,
    b: 0x7b425ed097b425ed097b425ed097b425ed097b425ed097b4260b5e9c7710c864n,
    gx: 0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad245an,
    gy: 0x20ae19a1b8a086b4e01edd2c7748d14c923d4d7e6d7c61b229e9c5a27eced3d9n,
    n: 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn,
};
type Point = { x: bigint; y: bigint } | null; // null is the point at infinity
const md = (v: bigint) => ((v % p) + p) % p;
const pw = (b: bigint, e: bigint): bigint => {
    let r = 1n;
    b = md(b);
    for (; e > 0n; e >>= 1n) {
        if (e & 1n) r = (r * b) % p;
        b = (b * b) % p;
    }
    return r;
};
const inv = (v: bigint) => pw(v, p - 2n);
const add = (P: Point, Q: Point): Point => {
    if (!P) return Q;
    if (!Q) return P;
    if (P.x === Q.x && md(P.y + Q.y) === 0n) return null;
    const lambda = P.x === Q.x ? md((3n * P.x * P.x + BC.a) * inv(2n * P.y)) : md((Q.y - P.y) * inv(Q.x - P.x));
    const x = md(lambda * lambda - P.x - Q.x);
    return { x, y: md(lambda * (P.x - x) - P.y) };
};
const mul = (k: bigint, P: Point): Point => {
    let result: Point = null;
    for (let addend = P; k > 0n; k >>= 1n, addend = add(addend, addend)) if (k & 1n) result = add(result, addend);
    return result;
};
const G: Point = { x: BC.gx, y: BC.gy };
const be32 = (v: bigint) => Buffer.from(v.toString(16).padStart(64, "0"), "hex");
const NAMED_HEADER = Buffer.from("305b301506072a8648ce3d0201060a2b060104019755010501034200", "hex");
const spkiOf = (P: { x: bigint; y: bigint }, header = NAMED_HEADER) => Buffer.concat([header, Buffer.from([4]), be32(P.x), be32(P.y)]).toString("base64");
const pointOf = (keyValue: string) => {
    const bytes = Buffer.from(keyValue, "base64").subarray(-65);
    return { x: BigInt(`0x${bytes.subarray(1, 33).toString("hex")}`), y: BigInt(`0x${bytes.subarray(33).toString("hex")}`) };
};
const leScalar = (bytes: Buffer) => BigInt(`0x${Buffer.from(bytes).reverse().toString("hex")}`);
/** What a HIP on BouncyCastle does: an unclamped random scalar in [1, n-1]. */
const randomBcScalar = () => (BigInt(`0x${randomBytes(32).toString("hex")}`) % (BC.n - 1n)) + 1n;

/** The scheme written out step by step, independent of the module, for the peer side. */
const independentEncrypt = (sharedX: Buffer, senderNonce: string, receiverNonce: string, plaintext: string) => {
    const a = Buffer.from(senderNonce, "base64");
    const b = Buffer.from(receiverNonce, "base64");
    const xor = Buffer.from(a.map((byte, i) => byte ^ b[i]));
    const key = Buffer.from(hkdfSync("sha256", sharedX, xor.subarray(0, 20), Buffer.alloc(0), 32));
    const cipher = createCipheriv("aes-256-gcm", key, xor.subarray(20));
    return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64");
};

const vectors = JSON.parse(readFileSync(new URL("./__fixtures__/fidelius-vectors.json", import.meta.url), "utf8")) as {
    curve: Record<string, string>;
    vectors: Array<Record<string, string>>;
};

const isReason = (reason: string) => (error: unknown) => error instanceof HiuCryptoError && error.reason === reason;

// ---------------------------------------------------------------------------------------------

test("the Weierstrass constants match BouncyCastle's curve25519", () => {
    assert.equal(WEIERSTRASS_A, BC.a);
    assert.equal(WEIERSTRASS_B, BC.b);
    assert.equal(montgomeryUToWeierstrassX(9n), BC.gx);
    assert.equal(md(BC.gy * BC.gy), md(BC.gx ** 3n + BC.a * BC.gx + BC.b));
    assert.equal(mul(BC.n, G), null, "n is the order of G");
    for (const [name, value] of Object.entries({ a: BC.a, b: BC.b, gx: BC.gx, gy: BC.gy, n: BC.n })) {
        assert.equal(BigInt(`0x${vectors.curve[name]}`), value, `BouncyCastle 1.79 agrees on ${name}`);
    }
});

test("Node's X25519 matches RFC 7748 (sections 5.2 and 6.1)", () => {
    const x25519 = (scalarHex: string, uHex: string) =>
        diffieHellman({
            privateKey: createPrivateKey({ key: Buffer.from(`302e020100300506032b656e04220420${scalarHex}`, "hex"), format: "der", type: "pkcs8" }),
            publicKey: createPublicKey({ key: Buffer.from(`302a300506032b656e032100${uHex}`, "hex"), format: "der", type: "spki" }),
        }).toString("hex");
    assert.equal(
        x25519("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4", "e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c"),
        "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552",
    );
    // Section 5.2, the iterated test after one iteration: k = u = 9.
    const nine = `09${"00".repeat(31)}`;
    assert.equal(x25519(nine, nine), "422c8e7a6227d7bca1350b3e2bb7279f7897b87bb6854b783c60e80311ae3079");
    // Section 6.1: each public key is X25519(private, 9).
    assert.equal(x25519("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", nine), "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
    assert.equal(x25519("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb", nine), "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
});

test("RFC 7748 section 6.1 through the module: public keys and the shared secret, in Weierstrass x", () => {
    const le = (hex: string) => leScalar(Buffer.from(hex, "hex"));
    const alicePrivate = Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex");
    const alicePublicU = le("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
    const bobPrivate = Buffer.from("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb", "hex");
    const bobPublicU = le("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
    const sharedU = le("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");

    assert.equal(pointOf(publicKeyValueOf(alicePrivate)).x, md(alicePublicU + (486662n * inv(3n))));
    assert.equal(pointOf(publicKeyValueOf(bobPrivate)).x, montgomeryUToWeierstrassX(bobPublicU));
    const expected = be32(montgomeryUToWeierstrassX(sharedU));
    assert.deepEqual(sharedSecretX(alicePrivate, publicKeyValueOf(bobPrivate)), expected);
    assert.deepEqual(sharedSecretX(bobPrivate, publicKeyValueOf(alicePrivate)), expected);
});

test("the published point is clamp(privateKey) * G on the Weierstrass curve (y up to sign)", () => {
    for (let i = 0; i < 4; i += 1) {
        const material = generateKeyMaterial();
        const expected: { x: bigint; y: bigint } = mul(leScalar(material.privateKey), G)!;
        const published = pointOf(material.publicKeyValue);
        assert.equal(published.x, expected.x);
        // X25519 gives only u; the module publishes the even root. The other root is -(k*G), whose
        // ECDH with any point has the same x, so the sign never changes the shared secret.
        assert.ok(published.y === expected.y || published.y === p - expected.y);
        assert.equal(published.y % 2n, 0n);
    }
});

test("ECDH with an unclamped BouncyCastle-style peer yields the same 32-byte secret on both sides", () => {
    for (let i = 0; i < 3; i += 1) {
        const ours = generateKeyMaterial();
        const d = randomBcScalar();
        const theirPoint = mul(d, G)!;
        const theirShared = mul(d, pointOf(ours.publicKeyValue))!;

        const ourShared = sharedSecretX(ours.privateKey, spkiOf(theirPoint));
        assert.equal(ourShared.length, 32);
        assert.deepEqual(ourShared, be32(theirShared.x));

        // The peer encrypts with its own derivation; the module decrypts it.
        const theirNonce = randomBytes(32).toString("base64");
        const plaintext = `{"resourceType":"Bundle","id":"synthetic-${i}"}`;
        const content = independentEncrypt(be32(theirShared.x), theirNonce, ours.nonce, plaintext);
        const decrypted = decryptEntry({ privateKey: ours.privateKey, ourNonce: ours.nonce, peerPublicKeyValue: spkiOf(theirPoint), peerNonce: theirNonce, content });
        assert.equal(decrypted.toString("utf8"), plaintext);
    }
});

test("BouncyCastle 1.79 vectors: our key encoding, the shared secret, decryption and encryption byte for byte", () => {
    assert.ok(vectors.vectors.length >= 4);
    for (const v of vectors.vectors) {
        const privateKey = Buffer.from(v.hiuPrivateKey, "base64");
        const ours = Buffer.from(publicKeyValueOf(privateKey), "base64");
        const bcNamed = Buffer.from(v.hiuPublicKeyNamedSpki, "base64");
        // Same SPKI header as BouncyCastle's named-curve encoding, same x, y equal up to sign.
        assert.deepEqual(ours.subarray(0, 28), bcNamed.subarray(0, 28), v.name);
        assert.equal(ours.length, bcNamed.length);
        const point = pointOf(ours.toString("base64"));
        assert.equal(point.x, BigInt(`0x${v.hiuPublicX}`), v.name);
        const bcY = BigInt(`0x${v.hiuPublicY}`);
        assert.ok(point.y === bcY || point.y === p - bcY, v.name);

        assert.equal(sharedSecretX(privateKey, v.hipPublicKey).toString("hex"), v.sharedSecretX, v.name);
        const decrypted = decryptEntry({ privateKey, ourNonce: v.hiuNonce, peerPublicKeyValue: v.hipPublicKey, peerNonce: v.hipNonce, content: v.contentHipToHiu });
        assert.equal(decrypted.toString("utf8"), v.plaintext, v.name);
        assert.equal(checksumOf(decrypted), v.checksum, v.name);
        assert.equal(checksumOf(v.plaintext), v.checksum, v.name);

        const encrypted = encryptEntry({ privateKey, ourNonce: v.hiuNonce, peerPublicKeyValue: v.hipPublicKey, peerNonce: v.hipNonce, plaintext: v.plaintext });
        assert.equal(encrypted, v.contentHiuToHip, v.name);
    }
});

test("round trip between two fresh key pairs, in both directions, with string and binary plaintext", () => {
    const hiu = generateKeyMaterial();
    const hip = generateKeyMaterial();
    const plaintext = Buffer.concat([Buffer.from('{"resourceType":"Bundle"}', "utf8"), randomBytes(3000)]);
    const content = encryptEntry({ privateKey: hip.privateKey, ourNonce: hip.nonce, peerPublicKeyValue: hiu.publicKeyValue, peerNonce: hiu.nonce, plaintext });
    assert.deepEqual(decryptEntry({ privateKey: hiu.privateKey, ourNonce: hiu.nonce, peerPublicKeyValue: hip.publicKeyValue, peerNonce: hip.nonce, content }), plaintext);

    const back = encryptEntry({ privateKey: hiu.privateKey, ourNonce: hiu.nonce, peerPublicKeyValue: hip.publicKeyValue, peerNonce: hip.nonce, plaintext: "héllo" });
    assert.equal(decryptEntry({ privateKey: hip.privateKey, ourNonce: hip.nonce, peerPublicKeyValue: hiu.publicKeyValue, peerNonce: hiu.nonce, content: back }).toString("utf8"), "héllo");
    assert.equal(Buffer.from(content, "base64").length, plaintext.length + 16, "the 16-byte tag is appended");
});

test("a tampered tag, ciphertext, nonce or key fails as decrypt-failed or the matching reason", () => {
    const hiu = generateKeyMaterial();
    const hip = generateKeyMaterial();
    const content = encryptEntry({ privateKey: hip.privateKey, ourNonce: hip.nonce, peerPublicKeyValue: hiu.publicKeyValue, peerNonce: hiu.nonce, plaintext: "record" });
    const base = { privateKey: hiu.privateKey, ourNonce: hiu.nonce, peerPublicKeyValue: hip.publicKeyValue, peerNonce: hip.nonce, content };

    const flip = (index: number) => {
        const bytes = Buffer.from(content, "base64");
        bytes[(index + bytes.length) % bytes.length] ^= 1;
        return bytes.toString("base64");
    };
    assert.throws(() => decryptEntry({ ...base, content: flip(-1) }), isReason("decrypt-failed"));
    assert.throws(() => decryptEntry({ ...base, content: flip(0) }), isReason("decrypt-failed"));
    assert.throws(() => decryptEntry({ ...base, peerNonce: randomBytes(32).toString("base64") }), isReason("decrypt-failed"));
    assert.throws(() => decryptEntry({ ...base, ourNonce: randomBytes(32).toString("base64") }), isReason("decrypt-failed"));
    assert.throws(() => decryptEntry({ ...base, peerPublicKeyValue: generateKeyMaterial().publicKeyValue }), isReason("decrypt-failed"));
    assert.throws(() => decryptEntry({ ...base, content: "AAAA" }), isReason("decrypt-failed"));
    assert.throws(() => decryptEntry({ ...base, content: "not base64!" }), isReason("decrypt-failed"));
    assert.throws(() => decryptEntry({ ...base, peerNonce: randomBytes(16).toString("base64") }), isReason("bad-nonce"));
    assert.throws(() => decryptEntry({ ...base, peerNonce: "28236d89-cb13-479d-ad71-7a57d5f669a9" }), isReason("bad-nonce"));
    assert.throws(() => decryptEntry({ ...base, privateKey: Buffer.alloc(31) }), isReason("bad-key"));
});

test("the checksum is the hex MD5 of the plaintext, and a mismatch is detected", () => {
    const plaintext = '{"resourceType":"Bundle"}';
    assert.equal(checksumOf(plaintext), createHash("md5").update(plaintext, "utf8").digest("hex"));
    assert.equal(checksumOf(Buffer.from(plaintext)), checksumOf(plaintext));
    verifyChecksum(plaintext, checksumOf(plaintext));
    verifyChecksum(plaintext, ` ${checksumOf(plaintext).toUpperCase()} `);
    assert.throws(() => verifyChecksum(`${plaintext} `, checksumOf(plaintext)), isReason("checksum-mismatch"));
    assert.throws(() => verifyChecksum(plaintext, createHash("md5").update(plaintext).digest("base64")), isReason("checksum-mismatch"));
    assert.throws(() => verifyChecksum(plaintext, undefined), isReason("checksum-mismatch"));
});

test("a peer key is read from its trailing 65 bytes: explicit-parameter, named-curve or bare point", () => {
    const point = mul(randomBcScalar(), G)!;
    const explicitVector = vectors.vectors.find((v) => v.hipPublicKeyForm === "explicit")!;
    const explicitHeader = Buffer.from(explicitVector.hipPublicKey, "base64").subarray(0, -65);
    assert.equal(explicitHeader.length, 244, "BouncyCastle's explicit-parameter SPKI is 309 bytes");
    assert.ok(explicitVector.hipPublicKey.startsWith("MIIBMTCB6gYHKoZIzj0CAT"), "the prefix the ABDM docs show for a peer key");

    for (const keyValue of [spkiOf(point), spkiOf(point, explicitHeader), Buffer.concat([Buffer.from([4]), be32(point.x), be32(point.y)]).toString("base64")]) {
        assert.deepEqual(parsePeerPublicKey(keyValue), point);
    }
    // The spec's own keyValue example is a bare point on this curve.
    assert.doesNotThrow(() => parsePeerPublicKey("BFN7KTdOT0jIAExG2A8Jg+01wMPWxptiGqwHRVvtiVEsUq2FR7P2UdqZxJyPJSeR6muai21iQhasNxnhh8I5M+g="));
});

test("invalid and low-order peer points are refused as bad-key", () => {
    const point = mul(randomBcScalar(), G)!;
    const offCurve = { x: point.x, y: md(point.y + 1n) };
    const lowOrder = { x: montgomeryUToWeierstrassX(0n), y: 0n }; // order 2: u = 0
    const ours = generateKeyMaterial();
    const raw32 = createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), randomBytes(32)]), format: "der", type: "pkcs8" }))
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64");

    assert.throws(() => sharedSecretX(ours.privateKey, spkiOf(offCurve)), isReason("bad-key"));
    assert.throws(() => sharedSecretX(ours.privateKey, spkiOf(lowOrder)), isReason("bad-key"));
    assert.throws(() => sharedSecretX(ours.privateKey, spkiOf({ x: point.x + p, y: point.y })), isReason("bad-key"), "x must be below p");
    assert.throws(() => sharedSecretX(ours.privateKey, raw32), isReason("bad-key"), "a raw 32-byte X25519 key is not a Fidelius key");
    assert.throws(() => parsePeerPublicKey(Buffer.concat([Buffer.from([0x30, 0, 0, 0]), Buffer.from([4]), be32(point.x), be32(point.y)]).toString("base64")), isReason("bad-key"));
    assert.throws(() => parsePeerPublicKey(Buffer.concat([Buffer.from([2]), be32(point.x), be32(point.y)]).toString("base64")), isReason("bad-key"));
    assert.throws(() => parsePeerPublicKey(""), isReason("bad-key"));
    assert.throws(() => parsePeerPublicKey("%%%"), isReason("bad-key"));
});

// ---------------------------------------------------------------------------------------------
// Independent review: fixed-width encodings, large entries and base64 strictness.

/**
 * BouncyCastle 1.79 vectors picked by GenLeadingZero.java (.m3-ref/fidelius-vectors) because a
 * leading byte is zero: the shared secret, our public x, or the HIP's public x.
 * BouncyCastle's KeyAgreementSpi.bigIntToBytes pads to the field length (integerToBytes(r, 32)).
 */
const leadingZero = JSON.parse(readFileSync(new URL("./__fixtures__/fidelius-leading-zero.json", import.meta.url), "utf8")) as {
    vectors: Array<Record<string, string>>;
};

test("BouncyCastle leading-zero vectors: shared secret, our x and the HIP's x stay 32 bytes", () => {
    const seen = new Set(leadingZero.vectors.map((v) => v.leadingZero));
    assert.deepEqual([...seen].sort(), ["hipX", "hiuX", "shared"]);
    for (const v of leadingZero.vectors) {
        const privateKey = Buffer.from(v.hiuPrivateKey, "base64");
        const shared = sharedSecretX(privateKey, v.hipPublicKey);
        assert.equal(shared.length, 32, v.name);
        assert.equal(shared.toString("hex"), v.sharedSecretX, v.name);
        if (v.leadingZero === "shared") assert.equal(shared[0], 0, `${v.name}: BouncyCastle keeps the zero byte`);

        const ours = Buffer.from(publicKeyValueOf(privateKey), "base64");
        assert.equal(ours.length, 93, v.name);
        assert.equal(ours.subarray(29, 61).toString("hex"), v.hiuPublicX, `${v.name}: our x is BouncyCastle's x, zero-padded`);
        if (v.leadingZero === "hiuX") {
            assert.equal(ours[29], 0, v.name);
            // BouncyCastle's own named-curve encoding of the same point has the same x bytes.
            assert.deepEqual(ours.subarray(0, 61), Buffer.from(v.hiuPublicKeyNamedSpki, "base64").subarray(0, 61), v.name);
        }
        if (v.leadingZero === "hipX") assert.equal(Buffer.from(v.hipPublicKey, "base64").subarray(-64)[0], 0, v.name);

        const decrypted = decryptEntry({ privateKey, ourNonce: v.hiuNonce, peerPublicKeyValue: v.hipPublicKey, peerNonce: v.hipNonce, content: v.contentHipToHiu });
        assert.equal(decrypted.toString("utf8"), v.plaintext, v.name);
        verifyChecksum(decrypted, v.checksum);
        assert.equal(encryptEntry({ privateKey, ourNonce: v.hiuNonce, peerPublicKeyValue: v.hipPublicKey, peerNonce: v.hipNonce, plaintext: v.plaintext }), v.contentHiuToHip, v.name);
    }
});

test("BouncyCastle parses our exact keyValue, with y either sign, and agrees on the secret", () => {
    const parsed = JSON.parse(readFileSync(new URL("./__fixtures__/fidelius-bc-parses-ours.json", import.meta.url), "utf8")) as {
        vectors: Array<Record<string, string>>;
    };
    assert.ok(parsed.vectors.some((v) => v.ySign === "negated") && parsed.vectors.some((v) => v.ySign === "same"));
    for (const v of parsed.vectors) {
        const privateKey = Buffer.from(v.hiuPrivateKey, "base64");
        assert.equal(publicKeyValueOf(privateKey), v.hiuPublicKey, "the module still publishes these bytes");
        assert.equal(sharedSecretX(privateKey, v.hipPublicKey).toString("hex"), v.sharedSecretX, v.ySign);
    }
});

test("a shared x with a leading zero byte is used as 32 bytes, not stripped (random search)", () => {
    let found: { ours: ReturnType<typeof generateKeyMaterial>; theirPoint: { x: bigint; y: bigint }; shared: Buffer } | null = null;
    for (let i = 0; i < 20000 && !found; i += 1) {
        const ours = generateKeyMaterial();
        // The peer's public point from the module (fast); checked against the BigInt reference below.
        const theirKey = generateKeyMaterial().publicKeyValue;
        const shared = sharedSecretX(ours.privateKey, theirKey);
        if (shared[0] === 0) found = { ours, theirPoint: pointOf(theirKey), shared };
    }
    assert.ok(found, "a leading zero byte occurs about once in 256 tries");
    const { ours, theirPoint, shared } = found;
    assert.equal(shared.length, 32);
    // The independent affine implementation agrees: x(k * Peer) with k our clamped scalar.
    const reference = mul(leScalar(ours.privateKey), theirPoint)!;
    assert.deepEqual(shared, be32(reference.x));

    const theirNonce = randomBytes(32).toString("base64");
    const plaintext = '{"resourceType":"Bundle","id":"leading-zero"}';
    const content = independentEncrypt(shared, theirNonce, ours.nonce, plaintext);
    const input = { privateKey: ours.privateKey, ourNonce: ours.nonce, peerPublicKeyValue: spkiOf(theirPoint), peerNonce: theirNonce };
    assert.equal(decryptEntry({ ...input, content }).toString("utf8"), plaintext);
    // A peer that stripped the zero byte (a variable-length secret) derives another key: refused.
    const stripped = independentEncrypt(shared.subarray(1), theirNonce, ours.nonce, plaintext);
    assert.throws(() => decryptEntry({ ...input, content: stripped }), isReason("decrypt-failed"));
});

test("a multi-megabyte entry decrypts (the base64 check must not overflow the regexp stack)", () => {
    const hiu = generateKeyMaterial();
    const hip = generateKeyMaterial();
    const plaintext = randomBytes(8 * 1024 * 1024);
    const content = encryptEntry({ privateKey: hip.privateKey, ourNonce: hip.nonce, peerPublicKeyValue: hiu.publicKeyValue, peerNonce: hiu.nonce, plaintext });
    const decrypted = decryptEntry({ privateKey: hiu.privateKey, ourNonce: hiu.nonce, peerPublicKeyValue: hip.publicKeyValue, peerNonce: hip.nonce, content });
    assert.ok(decrypted.equals(plaintext));
    // A large invalid value is a decrypt-failed, never a RangeError.
    assert.throws(() => decryptEntry({ privateKey: hiu.privateKey, ourNonce: hiu.nonce, peerPublicKeyValue: hip.publicKeyValue, peerNonce: hip.nonce, content: `${content}!` }), isReason("decrypt-failed"));
});

test("base64 input: standard alphabet, MIME line breaks allowed, bad padding and base64url refused", () => {
    const hiu = generateKeyMaterial();
    const hip = generateKeyMaterial();
    const content = encryptEntry({ privateKey: hip.privateKey, ourNonce: hip.nonce, peerPublicKeyValue: hiu.publicKeyValue, peerNonce: hiu.nonce, plaintext: "x".repeat(200) });
    const base = { privateKey: hiu.privateKey, ourNonce: hiu.nonce, peerPublicKeyValue: hip.publicKeyValue, peerNonce: hip.nonce };
    const wrapped = content.replace(/(.{76})/g, "$1\r\n");
    assert.equal(decryptEntry({ ...base, content: wrapped }).toString("utf8"), "x".repeat(200));
    assert.equal(decryptEntry({ ...base, peerPublicKeyValue: hip.publicKeyValue.replace(/(.{64})/g, "$1\n"), content }).toString("utf8"), "x".repeat(200));
    // Unpadded standard base64 of 32 bytes (43 characters) is the same nonce.
    assert.equal(decryptEntry({ ...base, peerNonce: hip.nonce.replace(/=+$/, ""), content }).toString("utf8"), "x".repeat(200));

    const nonceBytes = randomBytes(32);
    nonceBytes[0] = 0xfb; // forces "+" or "/" into the text
    nonceBytes[1] = 0xff;
    const urlNonce = nonceBytes.toString("base64url");
    assert.ok(/[-_]/.test(urlNonce));
    assert.throws(() => decryptEntry({ ...base, peerNonce: urlNonce, content }), isReason("bad-nonce"));
    assert.throws(() => decryptEntry({ ...base, peerNonce: `${hip.nonce.slice(0, 42)}=`, content }), isReason("bad-nonce"), "padding on a 43-character value");
    assert.throws(() => decryptEntry({ ...base, peerNonce: `${hip.nonce}A`, content }), isReason("bad-nonce"));
    assert.throws(() => decryptEntry({ ...base, content: `${content.slice(0, -4)}A=A=` }), isReason("decrypt-failed"));
});

test("generateKeyMaterial is fresh every time, with the spec's shapes and literals", () => {
    const a = generateKeyMaterial();
    const b = generateKeyMaterial();
    assert.notDeepEqual(a.privateKey, b.privateKey);
    assert.notEqual(a.nonce, b.nonce);
    assert.equal(Buffer.from(a.nonce, "base64").length, 32);
    assert.equal(a.privateKey.length, 32);
    assert.equal(a.privateKey[0] & 7, 0, "clamped");
    assert.equal(a.privateKey[31] & 0xc0, 0x40, "clamped");
    const spki = Buffer.from(a.publicKeyValue, "base64");
    assert.equal(spki.length, 93);
    assert.ok(spki.subarray(0, 28).equals(NAMED_HEADER) && spki[28] === 4);
    assert.equal(KEY_MATERIAL_CRYPTO_ALG, "ECDH");
    assert.equal(KEY_MATERIAL_CURVE, "Curve25519");
    assert.equal(KEY_MATERIAL_PARAMETERS, "Curve25519/32byte random key");
    // An error never carries key material.
    try {
        decryptEntry({ privateKey: a.privateKey, ourNonce: a.nonce, peerPublicKeyValue: b.publicKeyValue, peerNonce: b.nonce, content: "AAAAAAAAAAAAAAAAAAAAAAAA" });
        assert.fail("should not decrypt");
    } catch (error) {
        const text = `${(error as Error).message} ${(error as Error).stack}`;
        assert.ok(!text.includes(a.nonce) && !text.includes(b.publicKeyValue) && !text.includes(a.privateKey.toString("base64")));
        assert.ok(!/expired/i.test((error as Error).message));
    }
});
