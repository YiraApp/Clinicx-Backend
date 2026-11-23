import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "crypto";
import { AbdmCallbackAuth, bearerToken, CallbackAuthError } from "./abdm-callback-auth.service.js";

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

const PUSH = { pinClient: false, lenientBearer: true, expiryGraceMs: 60 * 60_000 } as const;
const hipClaims = (exp = Math.floor(now / 1000) + 300) => ({ clientId: "SBX_SOME_HIP", exp });

test("the bearer is read exactly for callbacks, and leniently for the data push: any case, spaces, or a bare JWT", () => {
    for (const strictOnly of ["Bearer a.b.c", "Bearer  a.b.c "]) assert.equal(bearerToken(strictOnly), "a.b.c");
    for (const refused of ["bearer a.b.c", "BEARER a.b.c", " Bearer a.b.c", "a.b.c", undefined]) assert.equal(bearerToken(refused), "", String(refused));

    for (const header of ["Bearer a.b.c", "bearer a.b.c", "BEARER a.b.c", "  Bearer   a.b.c  ", "\tbearer a.b.c", "a.b.c", "  a.b.c "]) {
        assert.equal(bearerToken(header, true), "a.b.c", header);
    }
    for (const none of ["", "   ", "Bearer", "bearer  ", "Basic a.b.c", "Bearer a.b c", "Token a.b.c", undefined]) {
        assert.equal(bearerToken(none, true), "", String(none));
    }
});

test("the data push takes a lower-case, spaced or bare bearer, still only when ABDM signed it as RS256 with a known key", async () => {
    const token = sign(hipClaims());
    for (const header of [`bearer ${token}`, `BEARER ${token}`, `  Bearer   ${token}  `, token]) {
        assert.equal((await auth.verify(header, PUSH)).clientId, "SBX_SOME_HIP", header.slice(0, 8));
    }
    // The same headers stay refused on every other callback (and without lenientBearer).
    for (const header of [`bearer ${token}`, token]) {
        await assert.rejects(auth.verify(header, { pinClient: false }), (error: any) => error instanceof CallbackAuthError && error.reason === "no-token");
    }

    const refusedAs = (header: string | undefined, reason: string) =>
        assert.rejects(auth.verify(header, PUSH), (error: any) => error instanceof CallbackAuthError && error.reason === reason);
    await refusedAs(undefined, "no-token");
    await refusedAs("Basic dXNlcjpwYXNz", "no-token");
    await refusedAs(`Basic ${token}`, "no-token");
    // Unsigned, HS256, or no key id: never taken, however the bearer is written.
    const [, payload] = token.split(".");
    await refusedAs(`bearer ${b64({ alg: "none", kid: "gateway-key-1" })}.${payload}.`, "not-rs256");
    await refusedAs(`${b64({ alg: "HS256", kid: "gateway-key-1" })}.${payload}.c2ln`, "not-rs256");
    await refusedAs(`bearer ${b64({ alg: "RS256" })}.${payload}.c2ln`, "not-rs256");
    await refusedAs(`bearer ${sign(hipClaims(), "made-up-key")}`, "unknown-key");
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const head = `${b64({ alg: "RS256", kid: "gateway-key-1" })}.${b64(hipClaims())}`;
    await refusedAs(`bearer ${head}.${createSign("RSA-SHA256").update(head).sign(other.privateKey).toString("base64url")}`, "bad-signature");
    await refusedAs("bearer bm90.anVzdA.dA", "unreadable");
});

test("the data push takes a token signed by ABDM up to its grace after it ran out; past the grace it is refused and says how long ago", async () => {
    const minutesAgo = (minutes: number) => Math.floor(now / 1000) - minutes * 60;
    const warned: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
    try {
        assert.equal((await auth.verify(`Bearer ${sign(hipClaims(minutesAgo(30)))}`, PUSH)).clientId, "SBX_SOME_HIP");
        assert.equal((await auth.verify(`Bearer ${sign(hipClaims(minutesAgo(59)))}`, PUSH)).clientId, "SBX_SOME_HIP");
        assert.equal(warned.length, 2, "each use of the grace is logged");
        assert.match(warned[0]!, /ran out 30 minutes ago; taken within the 60-minute grace/);
        assert.ok(!warned.join(" ").includes(sign(hipClaims(minutesAgo(30))).split(".")[2]!), "never the token");

        await assert.rejects(auth.verify(`Bearer ${sign(hipClaims(minutesAgo(61)))}`, PUSH),
            (error: any) => error instanceof CallbackAuthError && error.reason === "ran-out" && error.ranOutMinutesAgo === 61 && /past the data push's 60-minute grace/.test(error.message));
        // A grace of 0 is the strict expiry; a token with no exp is never taken.
        await assert.rejects(auth.verify(`Bearer ${sign(hipClaims(minutesAgo(5)))}`, { ...PUSH, expiryGraceMs: 0 }), (error: any) => error.reason === "ran-out");
        await assert.rejects(auth.verify(`Bearer ${sign({ clientId: "SBX_SOME_HIP" })}`, PUSH), (error: any) => error.reason === "ran-out");
        // Not-before is still checked.
        await assert.rejects(auth.verify(`Bearer ${sign({ ...hipClaims(), nbf: Math.floor(now / 1000) + 600 })}`, PUSH), (error: any) => error.reason === "not-yet-valid");
    } finally {
        console.warn = originalWarn;
    }
});

test("every other callback keeps the strict expiry: a token two minutes past it is refused, with or without the pin", async () => {
    const twoMinutesAgo = Math.floor(now / 1000) - 120;
    await assert.rejects(auth.verify(`Bearer ${sign({ clientId: "gateway", exp: twoMinutesAgo })}`),
        (error: any) => error instanceof CallbackAuthError && error.reason === "ran-out" && error.message === "The callback token has run out.");
    await assert.rejects(auth.verify(`Bearer ${sign({ clientId: "SBX_SOME_HIP", exp: twoMinutesAgo })}`, { pinClient: false }), (error: any) => error.reason === "ran-out");
    // Inside the clock leeway it is still taken, as before.
    assert.equal((await auth.verify(`Bearer ${sign({ clientId: "gateway", exp: Math.floor(now / 1000) - 30 })}`)).clientId, "gateway");
    await assert.rejects(auth.verify(`Bearer ${sign({ clientId: "SBX_OTHER", exp: Math.floor(now / 1000) + 300 })}`), (error: any) => error.reason === "client-not-allowed");
});
