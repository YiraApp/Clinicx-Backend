import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { abdmConfig } from "../../../config/abdm.config.js";

/**
 * At-rest sealing for what the HIU keeps between calls: the ephemeral ECDH private keys of open
 * health-information requests, and decrypted records until their dataEraseAt (plan D4, D5).
 *
 * AES-256-GCM with a server key from ABDM_HIU_DATA_KEY (base64 of 32 bytes) and a fresh 12-byte
 * IV per value. A sealed value is self-describing:
 *
 *     hiu1:<keyId>:<base64 IV>:<base64 ciphertext || 16-byte tag>
 *
 * The "hiu1:<keyId>" prefix is the GCM additional data, so neither the version nor the key id can
 * be changed without open() refusing the value. The key id lets a rotated key open old rows while
 * they are re-sealed. Nothing here logs, and errors never carry the value or the key.
 */

export interface AtRestKeys {
    /** The id seal() writes with. */
    currentId: string;
    /** Every key open() may use, by id. Each is 32 bytes. */
    keys: Map<string, Buffer>;
}

/** Why a sealed value could not be opened. Messages never carry the value or a key. */
export class HiuAtRestError extends Error {
    readonly reason: "malformed" | "unknown-key" | "tampered";

    constructor(reason: "malformed" | "unknown-key" | "tampered") {
        super(
            reason === "unknown-key"
                ? "A stored value was sealed with a key this server does not hold."
                : reason === "malformed"
                  ? "A stored value is not in the sealed format."
                  : "A stored value failed its integrity check.",
        );
        this.name = "HiuAtRestError";
        this.reason = reason;
    }
}

const VERSION = "hiu1";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DEFAULT_KEY_ID = "k1";

const decodeKey = (value: string | undefined): Buffer | null => {
    const compact = (value ?? "").trim();
    if (!compact || !BASE64.test(compact) || compact.length % 4 !== 0) return null;
    const key = Buffer.from(compact, "base64");
    return key.length === 32 ? key : null;
};

/**
 * Builds the key set from raw settings. Null when the key is missing, not base64 or not 32 bytes,
 * or the id has characters outside [A-Za-z0-9_-]: the caller treats that as not-configured.
 */
export function atRestKeysFrom(settings: { key: string | undefined; keyId: string | undefined }): AtRestKeys | null {
    const key = decodeKey(settings.key);
    const keyId = (settings.keyId ?? "").trim() || DEFAULT_KEY_ID;
    if (!key || !KEY_ID_PATTERN.test(keyId)) return null;
    return { currentId: keyId, keys: new Map([[keyId, key]]) };
}

/** ABDM_HIU_DATA_KEY / ABDM_HIU_DATA_KEY_ID (default k1). Null when the key is missing or not 32 bytes. */
export function atRestKeysFromConfig(): AtRestKeys | null {
    return atRestKeysFrom({ key: abdmConfig.hiuDataKey, keyId: abdmConfig.hiuDataKeyId });
}

const header = (keyId: string): string => `${VERSION}:${keyId}`;

/** Seals [plain] (strings as UTF-8) with the current key. */
export function seal(plain: Buffer | string, keys: AtRestKeys): string {
    const key = keys.keys.get(keys.currentId);
    if (!key || key.length !== 32 || !KEY_ID_PATTERN.test(keys.currentId)) throw new HiuAtRestError("unknown-key");
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
    cipher.setAAD(Buffer.from(header(keys.currentId), "utf8"));
    const data = typeof plain === "string" ? Buffer.from(plain, "utf8") : plain;
    const body = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
    return `${header(keys.currentId)}:${iv.toString("base64")}:${body.toString("base64")}`;
}

/** Opens a value seal() produced. Throws HiuAtRestError on any other format, an unknown key id or tampering. */
export function open(sealed: string, keys: AtRestKeys): Buffer {
    const parts = typeof sealed === "string" ? sealed.split(":") : [];
    if (parts.length !== 4 || parts[0] !== VERSION || !KEY_ID_PATTERN.test(parts[1]) || !BASE64.test(parts[2]) || !BASE64.test(parts[3])) {
        throw new HiuAtRestError("malformed");
    }
    const [, keyId, ivText, bodyText] = parts;
    const key = keys.keys.get(keyId);
    if (!key) throw new HiuAtRestError("unknown-key");
    const iv = Buffer.from(ivText, "base64");
    const body = Buffer.from(bodyText, "base64");
    if (iv.length !== IV_LENGTH || body.length < TAG_LENGTH) throw new HiuAtRestError("malformed");
    try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
        decipher.setAAD(Buffer.from(header(keyId), "utf8"));
        decipher.setAuthTag(body.subarray(body.length - TAG_LENGTH));
        return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_LENGTH)), decipher.final()]);
    } catch {
        throw new HiuAtRestError("tampered");
    }
}
