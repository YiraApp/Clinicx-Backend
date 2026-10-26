import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "crypto";

/**
 * Health records between HIP and HIU, encrypted the way Fidelius (ABDM's reference) does it
 * (ABDM: "Fidelius ECDH interop", shared.concept.fidelius-ecdh-interop):
 *   - ECDH on Curve25519 in its short Weierstrass form, as BouncyCastle has it. The scalar maths is
 *     X25519's, so it runs on Node's X25519 and only the point encoding is converted:
 *     Weierstrass x = Montgomery u + A/3 (mod p).
 *   - Public keys travel as X.509 SubjectPublicKeyInfo around the uncompressed point 04||x||y;
 *     a peer's key is read from its trailing 65 bytes, whatever parameters precede them.
 *   - The two 32 byte nonces are XORed: the first 20 bytes are the HKDF salt, the last 12 the IV.
 *   - key = HKDF-SHA256(x of the shared point, salt, empty info, 32 bytes); AES-256-GCM, no AAD,
 *     the 16 byte tag appended to the ciphertext, base64.
 * A fresh key pair and nonce for every transfer.
 */

const P = 2n ** 255n - 19n;
const A = 486662n;

const mod = (x: bigint): bigint => ((x % P) + P) % P;
const powMod = (base: bigint, exp: bigint): bigint => {
    let result = 1n;
    let b = mod(base);
    let e = exp;
    while (e > 0n) {
        if (e & 1n) result = (result * b) % P;
        b = (b * b) % P;
        e >>= 1n;
    }
    return result;
};
const inverse = (x: bigint): bigint => powMod(x, P - 2n);

const A_OVER_3 = mod(A * inverse(3n));
/** Short Weierstrass form of Curve25519 (y² = x³ + ax + b), as BouncyCastle defines it. */
export const CURVE = {
    p: P,
    a: mod((3n - A * A) * inverse(3n)),
    b: mod((2n * A * A * A - 9n * A) * inverse(27n)),
    gx: mod(9n + A_OVER_3),
};

const SQRT_MINUS_ONE = powMod(2n, (P - 1n) / 4n);
/** A square root mod p (p ≡ 5 mod 8); either root does, ECDH reads only x. */
const sqrt = (n: bigint): bigint => {
    const candidate = powMod(n, (P + 3n) / 8n);
    if (mod(candidate * candidate) === mod(n)) return candidate;
    const other = mod(candidate * SQRT_MINUS_ONE);
    if (mod(other * other) === mod(n)) return other;
    throw new HieCryptoError("Not a point on Curve25519.");
};

export class HieCryptoError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HieCryptoError";
    }
}

const toBigEndian = (x: bigint): Buffer => Buffer.from(x.toString(16).padStart(64, "0"), "hex");
const fromBigEndian = (b: Buffer): bigint => BigInt("0x" + b.toString("hex"));
const toLittleEndian = (x: bigint): Buffer => Buffer.from(toBigEndian(x)).reverse();
const fromLittleEndian = (b: Buffer): bigint => fromBigEndian(Buffer.from(b).reverse());

export const montgomeryToWeierstrassX = (u: bigint): bigint => mod(u + A_OVER_3);
export const weierstrassToMontgomeryU = (x: bigint): bigint => mod(x - A_OVER_3);

// SubjectPublicKeyInfo: id-ecPublicKey (1.2.840.10045.2.1) on curve25519 (1.3.6.1.4.1.3029.1.5.1)
const der = (tag: number, content: Buffer): Buffer => {
    if (content.length > 127) throw new HieCryptoError("DER length too long for this encoder.");
    return Buffer.concat([Buffer.from([tag, content.length]), content]);
};
const ALGORITHM = der(0x30, Buffer.concat([
    der(0x06, Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01])),
    der(0x06, Buffer.from([0x2b, 0x06, 0x01, 0x04, 0x01, 0x97, 0x55, 0x01, 0x05, 0x01])),
]));

/** An X25519 public key as Fidelius sends it: SPKI around 04||x||y in Weierstrass form, base64. */
export const encodePublicKey = (montgomeryU: bigint): string => {
    const x = montgomeryToWeierstrassX(montgomeryU);
    const y = sqrt(mod(x * x * x + CURVE.a * x + CURVE.b));
    const point = Buffer.concat([Buffer.from([0x04]), toBigEndian(x), toBigEndian(y)]);
    return der(0x30, Buffer.concat([ALGORITHM, der(0x03, Buffer.concat([Buffer.from([0x00]), point]))])).toString("base64");
};

/** A peer's public key, whichever SPKI form it came in: the trailing 65 bytes are the point. */
export const decodePublicKey = (base64: string): bigint => {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length < 65) throw new HieCryptoError("The public key is too short to hold a Curve25519 point.");
    const point = bytes.subarray(bytes.length - 65);
    if (point[0] !== 0x04) throw new HieCryptoError("The public key is not an uncompressed point.");
    const x = fromBigEndian(point.subarray(1, 33));
    const y = fromBigEndian(point.subarray(33, 65));
    if (mod(y * y) !== mod(x * x * x + CURVE.a * x + CURVE.b)) throw new HieCryptoError("The public key is not on Curve25519.");
    return weierstrassToMontgomeryU(x);
};

const x25519Public = (u: bigint): KeyObject =>
    createPublicKey({ key: { kty: "OKP", crv: "X25519", x: toLittleEndian(u).toString("base64url") }, format: "jwk" });

export interface KeyMaterial {
    privateKey: KeyObject;
    /** SPKI, base64: what goes in dhPublicKey.keyValue. */
    publicKey: string;
    /** 32 random bytes, base64. */
    nonce: string;
}

/** A fresh key pair and nonce: one per transfer, never reused. */
export const generateKeyMaterial = (): KeyMaterial => {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const u = fromLittleEndian(Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url"));
    return { privateKey, publicKey: encodePublicKey(u), nonce: randomBytes(32).toString("base64") };
};

/** The x coordinate (Weierstrass, 32 bytes big-endian) of our private key times the peer's point. */
export const sharedSecretX = (privateKey: KeyObject, peerPublicKey: string): Buffer => {
    const u = fromLittleEndian(diffieHellman({ privateKey, publicKey: x25519Public(decodePublicKey(peerPublicKey)) }));
    return toBigEndian(montgomeryToWeierstrassX(u));
};

const sessionKey = (secretX: Buffer, ownNonce: string, peerNonce: string) => {
    const a = Buffer.from(ownNonce, "base64");
    const b = Buffer.from(peerNonce, "base64");
    if (a.length !== 32 || b.length !== 32) throw new HieCryptoError("Both nonces must be 32 bytes.");
    const mixed = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) mixed[i] = a[i]! ^ b[i]!;
    const salt = mixed.subarray(0, 20);
    const iv = mixed.subarray(20);
    const key = Buffer.from(hkdfSync("sha256", secretX, salt, Buffer.alloc(0), 32));
    return { key, iv };
};

/** Encrypts [plain] for the peer: base64 of ciphertext with the tag appended. */
export const encrypt = (plain: string, own: KeyMaterial, peer: { publicKey: string; nonce: string }): string => {
    const { key, iv } = sessionKey(sharedSecretX(own.privateKey, peer.publicKey), own.nonce, peer.nonce);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([body, cipher.getAuthTag()]).toString("base64");
};

/** The HIU's side, for tests and for proving a round trip: fails when the tag does not check. */
export const decrypt = (base64: string, own: KeyMaterial, peer: { publicKey: string; nonce: string }): string => {
    const { key, iv } = sessionKey(sharedSecretX(own.privateKey, peer.publicKey), own.nonce, peer.nonce);
    const data = Buffer.from(base64, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8");
};

/** The push entry's checksum: MD5 of the content before encryption. */
export const checksum = (plain: string): string => createHash("md5").update(plain, "utf8").digest("hex");

