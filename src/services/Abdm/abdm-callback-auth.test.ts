import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "crypto";
import { AbdmCallbackAuth, CallbackAuthError } from "./abdm-callback-auth.service.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "gateway-key-1", alg: "RS256", use: "sig" };

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const sign = (claims: object, kid = "gateway-key-1") => {
    const head = `${b64({ alg: "RS256", typ: "JWT", kid })}.${b64(claims)}`;
    const signer = createSign("RSA-SHA256");
    signer.update(head);
    return `${head}.${signer.sign(privateKey).toString("base64url")}`;
};

let now: number;
let fetches: number;
let published: object[];
let auth: AbdmCallbackAuth;
let allowedCallers: string[];

beforeEach(() => {
    allowedCallers = ["gateway"];
    now = 1_700_000_000_000;
    fetches = 0;
    published = [jwk];
    auth = new AbdmCallbackAuth({
        async call<T>(): Promise<T> {
            fetches += 1;
            return { keys: published } as T;
        },
    }, () => now, { callbackClientIds: async () => allowedCallers });
});

const valid = () => ({ clientId: "gateway", exp: Math.floor(now / 1000) + 300 });

test("a token signed with ABDM's published key is accepted", async () => {
    const claims = await auth.verify(`Bearer ${sign(valid())}`);
    assert.equal(claims.clientId, "gateway");
    await auth.verify(`Bearer ${sign(valid())}`);
    assert.equal(fetches, 1, "the keys are cached");
});

test("a missing, tampered, expired or foreign token is refused", async () => {
    const refused = (header: string | undefined) => assert.rejects(auth.verify(header), CallbackAuthError);
    await refused(undefined);
    await refused("Bearer not.a.jwt");

    const [head, , signature] = sign(valid()).split(".");
    await refused(`Bearer ${head}.${b64({ ...valid(), clientId: "attacker" })}.${signature}`);
    await refused(`Bearer ${sign({ clientId: "gateway", exp: Math.floor(now / 1000) - 120 })}`);

    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const head2 = `${b64({ alg: "RS256", kid: "gateway-key-1" })}.${b64(valid())}`;
    const forged = createSign("RSA-SHA256").update(head2).sign(other.privateKey).toString("base64url");
    await refused(`Bearer ${head2}.${forged}`);
});

test("an unknown key id refreshes the keys for a rotation, but not on every made-up kid", async () => {
    await auth.verify(`Bearer ${sign(valid())}`);
    published = [{ ...jwk, kid: "gateway-key-2" }];
    await assert.rejects(auth.verify(`Bearer ${sign(valid(), "gateway-key-2")}`), CallbackAuthError);
    assert.equal(fetches, 1, "no refresh within minutes of the last fetch");

    now += 5 * 60_000;
    await auth.verify(`Bearer ${sign({ ...valid(), exp: Math.floor(now / 1000) + 300 }, "gateway-key-2")}`);
    assert.equal(fetches, 2);
});

test("only the pinned ABDM client may call, and with no pin nobody may (fail closed)", async () => {
    await assert.rejects(auth.verify(`Bearer ${sign({ ...valid(), clientId: "SBX_OTHER" })}`), CallbackAuthError);
    allowedCallers = [];
    await assert.rejects(auth.verify(`Bearer ${sign(valid())}`), /This call came from ABDM client "gateway"/);
});

test("without the client pin (a HIP's data push) any ABDM client's token passes, but the signature and expiry still count", async () => {
    delete process.env.ABDM_CALLBACK_CLIENT_IDS;
    const claims = await auth.verify(`Bearer ${sign({ ...valid(), clientId: "SBX_SOME_HIP" })}`, { pinClient: false });
    assert.equal(claims.clientId, "SBX_SOME_HIP");

    await assert.rejects(auth.verify(undefined, { pinClient: false }), CallbackAuthError);
    await assert.rejects(auth.verify(`Bearer ${sign({ clientId: "SBX_SOME_HIP", exp: Math.floor(now / 1000) - 120 })}`, { pinClient: false }), CallbackAuthError);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const head = `${b64({ alg: "RS256", kid: "gateway-key-1" })}.${b64(valid())}`;
    const forged = createSign("RSA-SHA256").update(head).sign(other.privateKey).toString("base64url");
    await assert.rejects(auth.verify(`Bearer ${head}.${forged}`, { pinClient: false }), CallbackAuthError);

    // The default is unchanged: the pin applies, and an empty pin list refuses everyone.
    await assert.rejects(auth.verify(`Bearer ${sign({ ...valid(), clientId: "SBX_SOME_HIP" })}`), CallbackAuthError);
    process.env.ABDM_CALLBACK_CLIENT_IDS = "gateway";
    await assert.rejects(auth.verify(`Bearer ${sign({ ...valid(), clientId: "SBX_SOME_HIP" })}`), /not allowed/);
});
