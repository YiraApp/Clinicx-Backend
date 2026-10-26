import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes } from "crypto";

/**
 * ABDM health-information transfer encryption (Milestone 3, ClinicX as HIU), compatible with
 * Fidelius, the reference implementation HIPs are built on.
 *
 * The scheme (docs: /docs/hiecm/v3/concepts/data-flow#data-flow-encryption, atom
 * shared.concept.fidelius-ecdh-interop):
 * - ECDH on Curve25519 in the short Weierstrass form BouncyCastle uses ("curve25519" in
 *   CustomNamedCurves), not the Montgomery form X25519 libraries use. Node has only X25519, so
 *   the scalar multiplication runs in OpenSSL's X25519 and only the encoding is converted:
 *   Weierstrass x = Montgomery u + A/3 (mod p), with A = 486662 and p = 2^255 - 19.
 * - keyValue: base64 X.509 SubjectPublicKeyInfo, OIDs 1.2.840.10045.2.1 (EC public key) and
 *   1.3.6.1.4.1.3029.1.5.1 (curve25519), bit string 04 || x || y. A peer's key is read as its
 *   trailing 65 bytes, so named-curve, explicit-parameter and bare-point encodings all work.
 * - The shared secret is the Weierstrass x of the ECDH point as 32 big-endian bytes (what
 *   BouncyCastle's JCA KeyAgreement.generateSecret returns).
 * - Each side's nonce is 32 random bytes in base64. XOR the two: bytes 0-19 are the HKDF salt,
 *   bytes 20-31 the AES-GCM IV.
 * - key = HKDF-SHA256(sharedX, salt, info empty, 32 bytes); AES-256-GCM, no AAD, the 16-byte tag
 *   appended to the ciphertext, the whole base64 encoded into entries[].content.
 * - entries[].checksum is the MD5 of the content before encryption (the plaintext), in hex
 *   (M2 spec, dataPushUrl body; atom hiecm.callback.m2-on-data-notification).
 *
 * Nothing here logs. Private keys, nonces, shared secrets and plaintext never leave the caller.
 */

export type HiuCryptoErrorReason = "bad-key" | "bad-nonce" | "decrypt-failed" | "checksum-mismatch";

/** Carries only a reason and a fixed message: never key material, nonces or content. */
export class HiuCryptoError extends Error {
    readonly reason: HiuCryptoErrorReason;

    constructor(reason: HiuCryptoErrorReason, message?: string) {
        super(message ?? DEFAULT_MESSAGES[reason]);
        this.name = "HiuCryptoError";
        this.reason = reason;
    }
}

const DEFAULT_MESSAGES: Record<HiuCryptoErrorReason, string> = {
    "bad-key": "The public key is not a valid Curve25519 key.",
    "bad-nonce": "The nonce is not 32 bytes of base64.",
    "decrypt-failed": "The entry could not be decrypted with this key material.",
    "checksum-mismatch": "The decrypted entry does not match its checksum.",
};

export interface HiuKeyMaterial {
    /** Our private scalar, 32 bytes, clamped, as Node's X25519 holds it. Secret. */
    privateKey: Buffer;
    /** keyMaterial.dhPublicKey.keyValue: base64 SPKI of the Weierstrass point. */
    publicKeyValue: string;
    /** keyMaterial.nonce: base64 of 32 random bytes. */
    nonce: string;
}

/** keyMaterial.cryptoAlg: "Always ECDH" (M3 spec, hiRequest.keyMaterial.cryptoAlg). */
export const KEY_MATERIAL_CRYPTO_ALG = "ECDH";
/** keyMaterial.curve: the M2 push schema enumerates exactly "Curve25519". Compare case-insensitively on receipt. */
export const KEY_MATERIAL_CURVE = "Curve25519";
/**
 * dhPublicKey.parameters: the only value the M2 push schema enumerates. The M3 request schema's
 * example is free text ("Ephemeral public key"); the value is descriptive and never parsed.
 */
export const KEY_MATERIAL_PARAMETERS = "Curve25519/32byte random key";

// ---------------------------------------------------------------------------------------------
// Field arithmetic on p = 2^255 - 19.

const P = 2n ** 255n - 19n;
const MONT_A = 486662n;

const mod = (value: bigint): bigint => {
    const r = value % P;
    return r < 0n ? r + P : r;
};

const modPow = (base: bigint, exponent: bigint): bigint => {
    let result = 1n;
    let b = mod(base);
    let e = exponent;
    while (e > 0n) {
        if (e & 1n) result = (result * b) % P;
        b = (b * b) % P;
        e >>= 1n;
    }
    return result;
};

const inverse = (value: bigint): bigint => modPow(value, P - 2n);

/** A/3 mod p: the shift between Montgomery u and Weierstrass x. */
const A_THIRD = mod(MONT_A * inverse(3n));
/** Short Weierstrass coefficients of the same curve: a = (3 - A^2)/3, b = (2A^3 - 9A)/27. */
export const WEIERSTRASS_A = mod((3n - MONT_A * MONT_A) * inverse(3n));
export const WEIERSTRASS_B = mod((2n * MONT_A ** 3n - 9n * MONT_A) * inverse(27n));
/** sqrt(-1) mod p, for the p = 5 mod 8 square root. */
const SQRT_MINUS_ONE = modPow(2n, (P - 1n) / 4n);

/** Montgomery u to Weierstrass x. */
export const montgomeryUToWeierstrassX = (u: bigint): bigint => mod(u + A_THIRD);
/** Weierstrass x to Montgomery u. */
export const weierstrassXToMontgomeryU = (x: bigint): bigint => mod(x - A_THIRD);

const curveRhs = (x: bigint): bigint => mod(x * x * x + WEIERSTRASS_A * x + WEIERSTRASS_B);

/** A square root of [value] mod p, or null when there is none (p = 5 mod 8 method). */
const sqrtMod = (value: bigint): bigint | null => {
    const v = mod(value);
    if (v === 0n) return 0n;
    let root = modPow(v, (P + 3n) / 8n);
    if ((root * root) % P !== v) root = (root * SQRT_MINUS_ONE) % P;
    return (root * root) % P === v ? root : null;
};

// ---------------------------------------------------------------------------------------------
// Byte encodings.

const bigFromBigEndian = (bytes: Buffer): bigint => (bytes.length === 0 ? 0n : BigInt(`0x${bytes.toString("hex")}`));
const bigToBigEndian32 = (value: bigint): Buffer => Buffer.from(value.toString(16).padStart(64, "0"), "hex");
const bigFromLittleEndian = (bytes: Buffer): bigint => bigFromBigEndian(Buffer.from(bytes).reverse());
const bigToLittleEndian32 = (value: bigint): Buffer => bigToBigEndian32(value).reverse();

/** DER prefixes Node accepts for raw X25519 keys (RFC 8410). */
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/**
 * SubjectPublicKeyInfo header for a named-curve key: SEQUENCE { SEQUENCE { OID ecPublicKey
 * 1.2.840.10045.2.1, OID curve25519 1.3.6.1.4.1.3029.1.5.1 }, BIT STRING (0 unused bits) }, then
 * the 65-byte point. This is what BouncyCastle encodes for a key on CustomNamedCurves' curve25519.
 */
const NAMED_CURVE_SPKI_PREFIX = Buffer.from("305b301506072a8648ce3d0201060a2b060104019755010501034200", "hex");
/** Every SPKI form ends with BIT STRING, length 66, no unused bits, then the point. */
const BIT_STRING_HEADER = Buffer.from("034200", "hex");
const POINT_LENGTH = 65;

/** X25519 clamping (RFC 7748 section 5): the scalar our published point is scalar * G for. */
const clamp = (scalar: Buffer): Buffer => {
    const clamped = Buffer.from(scalar);
    clamped[0] &= 248;
    clamped[31] &= 127;
    clamped[31] |= 64;
    return clamped;
};

const privateKeyObject = (privateKey: Buffer) => {
    if (!Buffer.isBuffer(privateKey) || privateKey.length !== 32) throw new HiuCryptoError("bad-key", "The private key is not 32 bytes.");
    return createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, privateKey]), format: "der", type: "pkcs8" });
};

/** Our Montgomery u (little-endian, as X25519 exports it) for [privateKey]. */
const montgomeryPublicU = (privateKey: Buffer): bigint => {
    const spki = createPublicKey(privateKeyObject(privateKey)).export({ format: "der", type: "spki" });
    return bigFromLittleEndian(Buffer.from(spki.subarray(spki.length - 32)));
};

/**
 * The keyValue for [privateKey]: SPKI of the Weierstrass point of clamp(privateKey) * G.
 * X25519 yields only u, so y is recovered by a square root and the even root is published; the
 * other root is the negated point, which yields the same shared x in any ECDH with it.
 */
export function publicKeyValueOf(privateKey: Buffer): string {
    const x = montgomeryUToWeierstrassX(montgomeryPublicU(privateKey));
    const root = sqrtMod(curveRhs(x));
    if (root === null) throw new HiuCryptoError("bad-key", "The private key does not give a point on the curve.");
    const y = root % 2n === 0n ? root : P - root;
    return Buffer.concat([NAMED_CURVE_SPKI_PREFIX, Buffer.from([0x04]), bigToBigEndian32(x), bigToBigEndian32(y)]).toString("base64");
}

/** A fresh key pair and nonce. One per health-information request, never reused. */
export function generateKeyMaterial(): HiuKeyMaterial {
    const privateKey = clamp(randomBytes(32));
    return { privateKey, publicKeyValue: publicKeyValueOf(privateKey), nonce: randomBytes(32).toString("base64") };
}

/**
 * Standard base64 characters with up to two trailing "=". A single character class keeps the test
 * linear with no backtracking state: a grouped pattern such as (?:[...]{4})* overflows V8's
 * regexp stack on entries of a few megabytes, and pages may be up to ABDM_DATA_PUSH_MAX_MB.
 */
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strict standard base64 (what Fidelius writes with java.util.Base64): padded to a multiple of 4,
 * or unpadded with a length of 2 or 3 mod 4. Whitespace (MIME line breaks) is ignored.
 */
const decodeBase64 = (value: unknown): Buffer | null => {
    if (typeof value !== "string") return null;
    const compact = /\s/.test(value) ? value.replace(/\s+/g, "") : value;
    if (compact.length === 0 || compact.length % 4 === 1 || !BASE64_CHARS.test(compact)) return null;
    if (compact.endsWith("=") && compact.length % 4 !== 0) return null;
    return Buffer.from(compact, "base64");
};

const decodeNonce = (nonce: string): Buffer => {
    const bytes = decodeBase64(nonce);
    if (!bytes || bytes.length !== 32) throw new HiuCryptoError("bad-nonce");
    return bytes;
};

/**
 * The peer's Weierstrass point from its keyValue: the trailing 65 bytes (04 || x || y) of an SPKI
 * in either named-curve or explicit-parameter form, or a bare 65-byte point. The parameters are
 * not parsed (atom shared.concept.fidelius-ecdh-interop); the point must lie on the curve.
 */
export function parsePeerPublicKey(keyValue: string): { x: bigint; y: bigint } {
    const bytes = decodeBase64(keyValue);
    if (!bytes || bytes.length < POINT_LENGTH) throw new HiuCryptoError("bad-key");
    if (bytes.length > POINT_LENGTH) {
        const header = bytes.subarray(bytes.length - POINT_LENGTH - BIT_STRING_HEADER.length, bytes.length - POINT_LENGTH);
        if (bytes[0] !== 0x30 || !header.equals(BIT_STRING_HEADER)) throw new HiuCryptoError("bad-key");
    }
    const point = bytes.subarray(bytes.length - POINT_LENGTH);
    if (point[0] !== 0x04) throw new HiuCryptoError("bad-key");
    const x = bigFromBigEndian(Buffer.from(point.subarray(1, 33)));
    const y = bigFromBigEndian(Buffer.from(point.subarray(33, 65)));
    if (x >= P || y >= P || mod(y * y) !== curveRhs(x)) throw new HiuCryptoError("bad-key");
    return { x, y };
}

/**
 * The ECDH shared secret as BouncyCastle's KeyAgreement returns it: the Weierstrass x of
 * clamp(privateKey) * peerPoint, 32 bytes big-endian. Low-order peer points give the all-zero
 * X25519 output, which OpenSSL refuses; both are reported as bad-key.
 */
export function sharedSecretX(privateKey: Buffer, peerPublicKeyValue: string): Buffer {
    const { x } = parsePeerPublicKey(peerPublicKeyValue);
    const peerU = weierstrassXToMontgomeryU(x);
    const peerKey = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, bigToLittleEndian32(peerU)]), format: "der", type: "spki" });
    let shared: Buffer;
    try {
        shared = diffieHellman({ privateKey: privateKeyObject(privateKey), publicKey: peerKey });
    } catch {
        throw new HiuCryptoError("bad-key");
    }
    const sharedU = bigFromLittleEndian(shared);
    if (sharedU === 0n) throw new HiuCryptoError("bad-key");
    return bigToBigEndian32(montgomeryUToWeierstrassX(sharedU));
}

/** The AES key and IV for one page, from our key and nonce and the peer's. */
const sessionKey = (privateKey: Buffer, ourNonce: string, peerPublicKeyValue: string, peerNonce: string): { key: Buffer; iv: Buffer } => {
    const ours = decodeNonce(ourNonce);
    const theirs = decodeNonce(peerNonce);
    const xor = Buffer.alloc(32);
    for (let i = 0; i < 32; i += 1) xor[i] = ours[i] ^ theirs[i];
    const salt = xor.subarray(0, 20);
    const iv = Buffer.from(xor.subarray(20, 32));
    const key = Buffer.from(hkdfSync("sha256", sharedSecretX(privateKey, peerPublicKeyValue), salt, Buffer.alloc(0), 32));
    return { key, iv };
};

const TAG_LENGTH = 16;

/** Decrypts one entries[].content. Throws HiuCryptoError: bad-key, bad-nonce or decrypt-failed. */
export function decryptEntry(input: { privateKey: Buffer; ourNonce: string; peerPublicKeyValue: string; peerNonce: string; content: string }): Buffer {
    const { key, iv } = sessionKey(input.privateKey, input.ourNonce, input.peerPublicKeyValue, input.peerNonce);
    const sealed = decodeBase64(input.content);
    if (!sealed || sealed.length < TAG_LENGTH) throw new HiuCryptoError("decrypt-failed");
    try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
        decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LENGTH));
        return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_LENGTH)), decipher.final()]);
    } catch {
        throw new HiuCryptoError("decrypt-failed");
    }
}

/** Encrypts one entry as a HIP would. Used for round trips in tests; the HIU never sends content. */
export function encryptEntry(input: { privateKey: Buffer; ourNonce: string; peerPublicKeyValue: string; peerNonce: string; plaintext: Buffer | string }): string {
    const { key, iv } = sessionKey(input.privateKey, input.ourNonce, input.peerPublicKeyValue, input.peerNonce);
    const plaintext = typeof input.plaintext === "string" ? Buffer.from(input.plaintext, "utf8") : input.plaintext;
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString("base64");
}

/**
 * entries[].checksum: MD5 of the PLAINTEXT (the content before encryption), lower-case hex.
 * Strings are hashed as UTF-8.
 */
export function checksumOf(data: Buffer | string): string {
    return createHash("md5").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");
}

/** Throws HiuCryptoError("checksum-mismatch") unless [checksum] is the hex MD5 of [plaintext] (any case). */
export function verifyChecksum(plaintext: Buffer | string, checksum: unknown): void {
    if (typeof checksum !== "string" || checksum.trim().toLowerCase() !== checksumOf(plaintext)) {
        throw new HiuCryptoError("checksum-mismatch");
    }
}
