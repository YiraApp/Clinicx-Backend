import { test } from "node:test";
import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateDecrypt } from "crypto";
import { AbdmCryptoService, paddingFor, toPublicKeyPem } from "./abdm-crypto.service.js";
import { AbdmApiError } from "./abdm-gateway.service.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
// ABDM publishes the key as base64 DER, without PEM armour.
const publishedKey = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const OAEP_SHA1 = "RSA/ECB/OAEPWithSHA-1AndMGF1Padding";

const fakeGateway = (encryptionAlgorithm: string) => {
    const gateway = {
        fetches: 0,
        async call<T>(): Promise<T> {
            gateway.fetches += 1;
            return { publicKey: publishedKey, encryptionAlgorithm } as T;
        },
    };
    return gateway;
};

test("encrypts with OAEP and SHA-1 when the certificate names it", async () => {
    const crypto = new AbdmCryptoService(fakeGateway(OAEP_SHA1));
    const ciphertext = await crypto.encrypt("123412341234");

    assert.ok(!ciphertext.includes("123412341234"));
    const decrypted = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(ciphertext, "base64"));
    assert.equal(decrypted.toString("utf8"), "123412341234");
    assert.throws(
        () => privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(ciphertext, "base64")),
        "SHA-256, most libraries' default, must not be what was used",
    );
});

test("an algorithm this system does not recognise is refused and not cached", async () => {
    const gateway = fakeGateway("RSA/ECB/OAEPWithSHA-256AndMGF1Padding");
    const crypto = new AbdmCryptoService(gateway);

    await assert.rejects(crypto.encrypt("123412341234"), (error: unknown) => error instanceof AbdmApiError && error.kind === "integration");
    await assert.rejects(crypto.encrypt("123412341234"));
    assert.equal(gateway.fetches, 2);
});

test("the certificate is cached for its validity window, then fetched again", async () => {
    let now = 0;
    const gateway = fakeGateway(OAEP_SHA1);
    const crypto = new AbdmCryptoService(gateway, () => now);

    await crypto.encrypt("a");
    await crypto.encrypt("b");
    assert.equal(gateway.fetches, 1);

    now += 60 * 60_000;
    await crypto.encrypt("c");
    assert.equal(gateway.fetches, 2);

    crypto.invalidate();
    await crypto.encrypt("d");
    assert.equal(gateway.fetches, 3);
});

test("padding follows the published algorithm name", () => {
    assert.deepEqual(paddingFor(OAEP_SHA1), { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" });
    assert.deepEqual(paddingFor("RSA/ECB/PKCS1Padding"), { padding: constants.RSA_PKCS1_PADDING });
    assert.throws(() => paddingFor("AES/GCM/NoPadding"));
});

test("the published key gains PEM armour", () => {
    const pem = toPublicKeyPem(publishedKey);
    assert.ok(pem.startsWith("-----BEGIN PUBLIC KEY-----\n"));
    assert.ok(pem.endsWith("\n-----END PUBLIC KEY-----"));
    assert.ok(pem.split("\n").slice(1, -1).every((line) => line.length <= 64));
    assert.equal(toPublicKeyPem(pem), pem);
});
