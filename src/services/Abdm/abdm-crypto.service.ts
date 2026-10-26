import { constants, publicEncrypt } from "crypto";
import { abdmConfig } from "../../config/abdm.config.js";
import { AbdmApiError, abdmGatewayService, type AbdmGatewayService } from "./abdm-gateway.service.js";

/**
 * Encrypts the values ABDM wants encrypted (Aadhaar, mobile, OTP) with the M1 public
 * certificate. The padding comes from the encryptionAlgorithm ABDM publishes beside the
 * key: an algorithm this file does not recognise is refused, never replaced by a default.
 */

const PADDINGS: Record<string, { padding: number; oaepHash?: string }> = {
    "RSA/ECB/OAEPWithSHA-1AndMGF1Padding": { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    "RSA/ECB/PKCS1Padding": { padding: constants.RSA_PKCS1_PADDING },
};

const CERTIFICATE_OPERATION = "profile/public/certificate";

export const paddingFor = (algorithm: string): { padding: number; oaepHash?: string } => {
    const padding = PADDINGS[algorithm.trim()];
    if (!padding) {
        throw new AbdmApiError({
            status: 0,
            kind: "integration",
            operation: CERTIFICATE_OPERATION,
            message: `ABDM published an encryption algorithm this system does not recognise ("${algorithm}"), so nothing was encrypted or sent.`,
        });
    }
    return padding;
};

/** ABDM sends the key as base64 DER with no PEM armour. */
export const toPublicKeyPem = (key: string): string => {
    const trimmed = key.trim();
    if (trimmed.includes("BEGIN")) return trimmed;
    const lines = trimmed.replace(/\s+/g, "").match(/.{1,64}/g) ?? [];
    return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
};

interface CachedCertificate {
    pem: string;
    algorithm: string;
    expiresAt: number;
}

export class AbdmCryptoService {
    private certificate: CachedCertificate | null = null;
    private pending: Promise<CachedCertificate> | null = null;
    private readonly gateway: Pick<AbdmGatewayService, "call">;
    private readonly clock: () => number;

    constructor(gateway: Pick<AbdmGatewayService, "call"> = abdmGatewayService, clock: () => number = Date.now) {
        this.gateway = gateway;
        this.clock = clock;
    }

    /** RSA-encrypts [plainText] and returns the base64 ABDM expects in the field. */
    async encrypt(plainText: string): Promise<string> {
        const certificate = await this.getCertificate();
        const { padding, oaepHash } = paddingFor(certificate.algorithm);
        const key = oaepHash ? { key: certificate.pem, padding, oaepHash } : { key: certificate.pem, padding };
        return publicEncrypt(key, Buffer.from(plainText, "utf8")).toString("base64");
    }

    /** Drops the cached certificate, for instance after ABDM refuses an encrypted field. */
    invalidate(): void {
        this.certificate = null;
    }

    private async getCertificate(): Promise<CachedCertificate> {
        if (this.certificate && this.clock() < this.certificate.expiresAt) {
            return this.certificate;
        }
        if (!this.pending) {
            this.pending = this.fetchCertificate().finally(() => {
                this.pending = null;
            });
        }
        return this.pending;
    }

    private async fetchCertificate(): Promise<CachedCertificate> {
        const body = await this.gateway.call<{ publicKey?: string; encryptionAlgorithm?: string }>({
            operation: CERTIFICATE_OPERATION,
            method: "GET",
            path: "/abha/api/v3/profile/public/certificate",
        });
        if (!body?.publicKey || !body?.encryptionAlgorithm) {
            throw new AbdmApiError({
                status: 502,
                kind: "unavailable",
                operation: CERTIFICATE_OPERATION,
                message: "ABDM's certificate answer had no public key or no encryption algorithm.",
            });
        }

        // Refuse an unknown algorithm before it is cached.
        paddingFor(body.encryptionAlgorithm);
        this.certificate = {
            pem: toPublicKeyPem(body.publicKey),
            algorithm: body.encryptionAlgorithm.trim(),
            expiresAt: this.clock() + abdmConfig.certificateCacheMs,
        };
        return this.certificate;
    }
}

export const abdmCryptoService = new AbdmCryptoService();
