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
 * - keyValue we send: by default the bare uncompressed point 04 || x || y in base64 (65 bytes).
 *   The HIU-to-HIP direction is a bare point in the reference code HIPs are built on: Fidelius
 *   makes the HIU key with getQ().getEncoded(false) (KeysController) and the HIP reads it only with
 *   curve.decodePoint (EncryptionController); ProjectEKA's hip-service reads it with
 *   Curve.DecodePoint (EncryptorHelper.cs); the PHR app sends it bare; every keyValue example in
 *   the M3 and M2 specs is a bare point. A decodePoint HIP throws "Invalid point encoding 0x30" on
 *   an SPKI, on every BouncyCastle version, and never pushes. The atom
 *   shared.concept.fidelius-ecdh-interop, and the spec's prose, say SPKI: that is wrong for this
 *   direction (a HIP sends its OWN key as SPKI). "spki" (ABDM_HIU_KEY_FORMAT, or per HIP with
 *   ABDM_HIU_SPKI_KEY_HIPS) gives the X.509 SubjectPublicKeyInfo, OIDs 1.2.840.10045.2.1 (EC public
 *   key) and 1.3.6.1.4.1.3029.1.5.1 (curve25519), around the same point, as ClinicX sent before.
 *   A peer's key is read as its trailing 65 bytes, so named-curve, explicit-parameter and
 *   bare-point encodings all work.
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
    /** keyMaterial.dhPublicKey.keyValue: base64 of the Weierstrass point, bare or in SPKI (KeyValueFormat). */
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
 * How keyValue is written: "point", the bare uncompressed point 04 || x || y (65 bytes), as the PHR
 * app sends it; "spki", that point in an X.509 SubjectPublicKeyInfo naming curve25519 (93 bytes).
 */
export type KeyValueFormat = "point" | "spki";

/**
 * The keyValue for [privateKey]: the Weierstrass point of clamp(privateKey) * G, bare (the
 * default) or in SPKI. X25519 yields only u, so y is recovered by a square root and the even root
 * is published; the other root is the negated point, which yields the same shared x in any ECDH.
 */
export function publicKeyValueOf(privateKey: Buffer, format: KeyValueFormat = "point"): string {
    const x = montgomeryUToWeierstrassX(montgomeryPublicU(privateKey));
    const root = sqrtMod(curveRhs(x));
    if (root === null) throw new HiuCryptoError("bad-key", "The private key does not give a point on the curve.");
    const y = root % 2n === 0n ? root : P - root;
    const point = Buffer.concat([Buffer.from([0x04]), bigToBigEndian32(x), bigToBigEndian32(y)]);
    return (format === "spki" ? Buffer.concat([NAMED_CURVE_SPKI_PREFIX, point]) : point).toString("base64");
}

/** A fresh key pair and nonce. One per health-information request, never reused. */
export function generateKeyMaterial(format: KeyValueFormat = "point"): HiuKeyMaterial {
    const privateKey = clamp(randomBytes(32));
    return { privateKey, publicKeyValue: publicKeyValueOf(privateKey, format), nonce: randomBytes(32).toString("base64") };
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
/**
 * The AES key and IV for one transfer. [stripLeadingZero]: the HKDF input is the shared x without
 * its leading zero byte(s), as a HIP built on ProjectEKA's hip-service derives it
 * (BigInteger.ToByteArrayUnsigned, EncryptorHelper.cs), about one transfer in 256; Fidelius and
 * BouncyCastle's JCA keep all 32 bytes, which is the default.
 */
const sessionKey = (privateKey: Buffer, ourNonce: string, peerPublicKeyValue: string, peerNonce: string, stripLeadingZero = false): { key: Buffer; iv: Buffer; sharedStartsWithZero: boolean } => {
    const ours = decodeNonce(ourNonce);
    const theirs = decodeNonce(peerNonce);
    const xor = Buffer.alloc(32);
    for (let i = 0; i < 32; i += 1) xor[i] = ours[i] ^ theirs[i];
    const salt = xor.subarray(0, 20);
    const iv = Buffer.from(xor.subarray(20, 32));
    const shared = sharedSecretX(privateKey, peerPublicKeyValue);
    let start = 0;
    if (stripLeadingZero) while (start < shared.length - 1 && shared[start] === 0) start += 1;
    const key = Buffer.from(hkdfSync("sha256", shared.subarray(start), salt, Buffer.alloc(0), 32));
    return { key, iv, sharedStartsWithZero: shared[0] === 0 };
};

const TAG_LENGTH = 16;

const openSealed = (key: Buffer, iv: Buffer, sealed: Buffer): Buffer | null => {
    try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
        decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LENGTH));
        return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_LENGTH)), decipher.final()]);
    } catch {
        return null;
    }
};

/**
 * Decrypts one entries[].content. Throws HiuCryptoError: bad-key, bad-nonce or decrypt-failed.
 * When the shared x starts with a zero byte and the 32-byte key does not open it, the key a
 * ProjectEKA-based HIP derives (that zero dropped) is tried once; GCM's tag decides, so a wrong
 * key can never be taken for a right one.
 */
export function decryptEntry(input: { privateKey: Buffer; ourNonce: string; peerPublicKeyValue: string; peerNonce: string; content: string }): Buffer {
    const { key, iv, sharedStartsWithZero } = sessionKey(input.privateKey, input.ourNonce, input.peerPublicKeyValue, input.peerNonce);
    const sealed = decodeBase64(input.content);
    if (!sealed || sealed.length < TAG_LENGTH) throw new HiuCryptoError("decrypt-failed");
    const opened = openSealed(key, iv, sealed)
        ?? (sharedStartsWithZero ? openSealed(sessionKey(input.privateKey, input.ourNonce, input.peerPublicKeyValue, input.peerNonce, true).key, iv, sealed) : null);
    if (!opened) throw new HiuCryptoError("decrypt-failed");
    return opened;
}

/**
 * Encrypts one entry as a HIP would. Used for round trips in tests; the HIU never sends content.
 * [stripLeadingZero] encrypts as a ProjectEKA-based HIP does (see sessionKey).
 */
export function encryptEntry(input: { privateKey: Buffer; ourNonce: string; peerPublicKeyValue: string; peerNonce: string; plaintext: Buffer | string; stripLeadingZero?: boolean }): string {
    const { key, iv } = sessionKey(input.privateKey, input.ourNonce, input.peerPublicKeyValue, input.peerNonce, input.stripLeadingZero ?? false);
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
/** Whether [checksum] is in the spec's form: 32 hex characters, an MD5 digest. */
export const isSpecChecksumForm = (checksum: unknown): boolean => typeof checksum === "string" && /^[0-9a-f]{32}$/i.test(checksum.trim());

/**
 * The form [checksum] takes when it is not the spec's (MD5 hex of the plaintext), among those
 * HIPs are seen to send: MD5, SHA-256 or SHA-1, of the plaintext, of the base64 content text or of
 * the ciphertext bytes, as hex, base64 (padded or not, or url-safe) or base64 of the hex text.
 * For example ASPIRE HIMS Vass sends 44 base64 characters. Null when it matches none of them.
 */
export function checksumFormOf(plaintext: Buffer, content: string, checksum: unknown): string | null {
    if (typeof checksum !== "string" || !checksum.trim()) return null;
    const given = checksum.trim();
    const unpadded = given.replace(/=+$/, "");
    const inputs: Array<[string, Buffer]> = [["plaintext", plaintext], ["content text", Buffer.from(content, "utf8")], ["ciphertext", decodeBase64(content) ?? Buffer.alloc(0)]];
    for (const algorithm of ["md5", "sha256", "sha1"]) {
        for (const [what, data] of inputs) {
            const raw = createHash(algorithm).update(data).digest();
            const hex = raw.toString("hex");
            if (given.toLowerCase() === hex) return `${algorithm} hex of the ${what}`;
            if (unpadded === raw.toString("base64").replace(/=+$/, "") || given === raw.toString("base64url")) return `${algorithm} base64 of the ${what}`;
            if (unpadded === Buffer.from(hex).toString("base64").replace(/=+$/, "") || unpadded === Buffer.from(hex.toUpperCase()).toString("base64").replace(/=+$/, "")) {
                return `${algorithm} hex, base64 encoded, of the ${what}`;
            }
        }
    }
    return null;
}

export function verifyChecksum(plaintext: Buffer | string, checksum: unknown): void {
    if (typeof checksum !== "string" || checksum.trim().toLowerCase() !== checksumOf(plaintext)) {
        throw new HiuCryptoError("checksum-mismatch");
    }
}
