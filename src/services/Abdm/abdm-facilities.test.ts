import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AbdmFacilityDirectory, FacilityClashError, FacilityError, hiuIdOf, type AbdmFacility, type FacilityInput, type FacilityStore } from "./abdm-facilities.service.js";

/** AbdmFacilities in memory: active rows only, as the repository lists them. */
let rows: Map<number, AbdmFacility & { isActive: boolean }>;
let saved: { hospitalId: number; input: FacilityInput }[];
/** Record requests ABDM may still answer, by "hospitalId|hiuId" (AbdmHiuConsentRequests). */
let openRequests: Map<string, number>;

const store: FacilityStore = {
    async openHiuRequests(hospitalId, hiuId) {
        return openRequests.get(`${hospitalId}|${hiuId}`) ?? 0;
    },
    async list() {
        return [...rows.values()].filter((row) => row.isActive).map(({ isActive: _active, ...facility }) => ({ ...facility }));
    },
    async save(hospitalId, input) {
        saved.push({ hospitalId, input });
        rows.set(hospitalId, {
            hospitalId,
            hipId: input.hipId ?? null,
            hiuId: input.hiuId ?? null,
            name: input.hipName || input.hipId || input.hiuId || input.scanShareHipId || "",
            scanShareHipId: input.scanShareHipId ?? null,
            autoLink: Boolean(input.autoLink),
            isActive: input.isActive !== false,
        });
    },
};

const facility = (hospitalId: number, ids: Partial<Pick<AbdmFacility, "hipId" | "hiuId" | "scanShareHipId" | "name">>) => {
    rows.set(hospitalId, { hospitalId, hipId: null, hiuId: null, scanShareHipId: null, name: `Hospital ${hospitalId}`, autoLink: false, isActive: true, ...ids });
};

let directory: AbdmFacilityDirectory;

beforeEach(() => {
    rows = new Map();
    saved = [];
    openRequests = new Map();
    directory = new AbdmFacilityDirectory(store);
    facility(19, { hipId: "IN3610001174", name: "A A Hospital" });                          // HIU id = its HIP id
    facility(20, { hipId: "IN3610002222", hiuId: "IN3610003333", name: "B B Clinic" });     // its own HIU id
    facility(21, { scanShareHipId: "Counter-HIP" });                                       // no HFR id: no HIU
    facility(22, { hiuId: "IN3610004444", name: "D Diagnostics" });                         // HIU only
});

test("a hospital's HIU id is its own HIU id, else its HIP id", async () => {
    assert.equal(hiuIdOf(rows.get(19)!), "IN3610001174");
    assert.equal(hiuIdOf(rows.get(20)!), "IN3610003333");
    assert.equal(hiuIdOf(rows.get(21)!), null);
    assert.deepEqual(await directory.hiu(19), { id: "IN3610001174", hospitalId: 19, name: "A A Hospital" });
    assert.deepEqual(await directory.hiu(20), { id: "IN3610003333", hospitalId: 20, name: "B B Clinic" });
    assert.deepEqual(await directory.hiu(22), { id: "IN3610004444", hospitalId: 22, name: "D Diagnostics" });
});

test("a hospital with no HIU id (nor HIP id), or no facility at all, has no HIU: never another's, never a default", async () => {
    assert.equal(await directory.hiu(21), null);
    assert.equal(await directory.hiu(99), null);
    assert.equal(await directory.hiu(null), null);
    assert.equal(await directory.hiu(undefined), null);
});

test("hiuById finds the one hospital acting as that HIU", async () => {
    assert.equal((await directory.hiuById("IN3610001174"))?.hospitalId, 19, "by its HIP id when it has no HIU id");
    assert.equal((await directory.hiuById("IN3610003333"))?.hospitalId, 20);
    assert.equal((await directory.hiuById("IN3610004444"))?.hospitalId, 22);
    assert.equal(await directory.hiuById("IN3610002222"), null, "a HIP id set apart from the HIU id is not an HIU");
    assert.equal(await directory.hiuById("IN0000000000"), null);
    assert.equal(await directory.hiuById(""), null);
    assert.equal(await directory.hiuById(null), null);
});

test("hiuById refuses an id two hospitals would answer to, rather than pick one", async () => {
    // Only possible with rows written around save()'s check; the directory still never guesses.
    facility(23, { hiuId: "IN3610001174" });
    assert.equal(await directory.hiuById("IN3610001174"), null);
});

test("hips stay as they were: an HIU-only facility is not an HIP", async () => {
    assert.deepEqual((await directory.hips()).map((hip) => hip.hospitalId).sort(), [19, 20]);
    assert.equal(await directory.hip(22), null);
});

test("save takes an HIU id (an HFR id, uppercased) and passes it to the store", async () => {
    const result = await directory.save(30, { hiuId: " in3610005555 ", hipName: "E Eye Care" }, null);
    assert.equal(saved.at(-1)!.input.hiuId, "IN3610005555");
    assert.equal(result?.hiuId, "IN3610005555");
    assert.deepEqual(await directory.hiu(30), { id: "IN3610005555", hospitalId: 30, name: "E Eye Care" });
    assert.equal((await directory.hiuById("IN3610005555"))?.hospitalId, 30, "the cache is dropped on save");
});

test("save refuses an HIU id that is not an HFR id", async () => {
    for (const hiuId of ["IN123", "XX3610005555", "IN36100055551", "Clinic-HIU"]) {
        await assert.rejects(directory.save(30, { hiuId }, null), (error: any) => error instanceof FacilityError && /HIU id/.test(error.message));
    }
    assert.equal(saved.length, 0);
});

test("save needs at least one id: an HFR id, an HIU id or a Scan and Share HIP id", async () => {
    await assert.rejects(directory.save(30, { hipName: "Nothing" }, null), FacilityError);
    await directory.save(31, { scanShareHipId: "Counter-2" }, null);
    await directory.save(32, { hiuId: "IN3610006666" }, null);
    await directory.save(33, { hipId: "IN3610007777" }, null);
    assert.deepEqual(saved.map((s) => s.hospitalId), [31, 32, 33]);
    assert.equal(saved[0]!.input.hiuId, null);
});

test("one HIU id serves one hospital: never another hospital's HIU id or HFR facility id", async () => {
    await assert.rejects(directory.save(30, { hiuId: "IN3610003333" }, null), (error: any) => error instanceof FacilityError && /hospital 20/.test(error.message));
    await assert.rejects(directory.save(30, { hiuId: "IN3610001174" }, null), (error: any) => error instanceof FacilityError && /hospital 19/.test(error.message));
    // A new HIP id with no HIU id would answer as an HIU id hospital 22 already uses.
    await assert.rejects(directory.save(30, { hipId: "IN3610004444" }, null), (error: any) => error instanceof FacilityError && /hospital 22/.test(error.message));
    assert.equal(saved.length, 0);

    // Another hospital's HFR facility is never an HIU id here, even when that hospital asks as another id.
    await assert.rejects(directory.save(30, { hiuId: "IN3610002222" }, null), (error: any) => error instanceof FacilityError && /hospital 20/.test(error.message));
    // Nor is a HIP id that another hospital asks as.
    await assert.rejects(directory.save(30, { hipId: "IN3610003333", hiuId: "IN3610008888" }, null), (error: any) => error instanceof FacilityError && /hospital 20/.test(error.message));
    assert.equal(saved.length, 0);

    // A hospital saving its own ids again is not a clash; nor is switching a facility off.
    await directory.save(20, { hipId: "IN3610002222", hiuId: "IN3610003333" }, null);
    await directory.save(31, { hiuId: "IN3610001174", isActive: false }, null);
    assert.deepEqual(saved.map((s) => s.hospitalId), [20, 31]);
});

test("a clash on the HFR facility id alone (the M2 setup) is named as that, as a 409 clash, not as an HIU id", async () => {
    await assert.rejects(directory.save(30, { hipId: "IN3610001174" }, null), (error: any) => {
        assert.ok(error instanceof FacilityClashError);
        assert.equal(error.message, "HFR facility id IN3610001174 is already used by another hospital (hospital 19).");
        return true;
    });
    // An HIU id the admin gave is named as an HIU id.
    await assert.rejects(directory.save(30, { hiuId: "IN3610003333" }, null), (error: any) => error instanceof FacilityClashError && /^HIU id IN3610003333 /.test(error.message));
    // A HIP id that another hospital asks as is named as the HFR facility id, even with an HIU id given.
    await assert.rejects(directory.save(30, { hipId: "IN3610003333", hiuId: "IN3610008888" }, null), (error: any) => error instanceof FacilityClashError && /^HFR facility id IN3610003333 /.test(error.message));
    // A bad value is still a plain 400, not a clash.
    await assert.rejects(directory.save(30, { hipId: "IN12" }, null), (error: any) => error instanceof FacilityError && !(error instanceof FacilityClashError));
    assert.equal(saved.length, 0);
});

test("an HIU set apart from the HIP id, with no name saved, is named by its own id, not the HIP id", async () => {
    await directory.save(30, { hipId: "IN1111111111", hiuId: "IN2222222222" }, null);
    assert.deepEqual(await directory.hiu(30), { id: "IN2222222222", hospitalId: 30, name: "IN2222222222" });
    await directory.save(31, { hipId: "IN1111111112" }, null);
    assert.equal((await directory.hiu(31))?.name, "IN1111111112", "a hospital asking as its HIP id keeps that name");
    await directory.save(32, { hipId: "IN1111111113", hiuId: "IN2222222223", hipName: "F Family Clinic" }, null);
    assert.equal((await directory.hiu(32))?.name, "F Family Clinic", "a saved name always wins");
});

test("switching a facility off needs no id and frees its ids for another hospital", async () => {
    const result = await directory.save(20, { isActive: false }, null);
    assert.equal(result, null);
    assert.deepEqual({ ...saved.at(-1)!.input, isActive: false }, { isActive: false, hipId: null, hiuId: null, hipName: null, scanShareHipId: null });
    // Ids sent with the switch-off (an older page sends them) are not kept on the inactive row either.
    await directory.save(19, { hipId: "IN3610001174", scanShareHipId: "Counter-19", isActive: false }, null);
    assert.equal(rows.get(19)!.hipId, null);
    assert.equal(rows.get(19)!.scanShareHipId, null);
    assert.equal(rows.get(20)!.hiuId, null);
    // So another hospital can take them (the unique indexes would otherwise still hold them).
    await directory.save(30, { hipId: "IN3610001174", hiuId: "IN3610003333" }, null);
    assert.equal((await directory.hiuById("IN3610003333"))?.hospitalId, 30);
});

test("a hospital keeps its HIU id while record requests raised as it are open: ABDM answers them to that id", async () => {
    openRequests.set("20|IN3610003333", 2);
    const refused = (error: any) => {
        assert.ok(error instanceof FacilityError && !(error instanceof FacilityClashError));
        assert.match(error.message, /record requests still open as HIU IN3610003333/);
        assert.doesNotMatch(error.message, /expired/i);
        return true;
    };
    await assert.rejects(directory.save(20, { hipId: "IN3610002222", hiuId: "IN3610009999" }, null), refused);
    await assert.rejects(directory.save(20, { hipId: "IN3610002222" }, null), refused, "dropping the HIU id falls back to the HIP id: a change too");
    await assert.rejects(directory.save(20, { isActive: false }, null), refused, "switching off would strand them too");
    assert.equal(saved.length, 0);

    // The same HIU id, with any other change (a new HIP id, a name), is not a change of HIU.
    await directory.save(20, { hipId: "IN3610007777", hiuId: "IN3610003333", hipName: "B B Clinic" }, null);
    // Hospital 19 asks as its HIP id: a new HIP id with no HIU id of its own is a change of HIU.
    openRequests.set("19|IN3610001174", 1);
    await assert.rejects(directory.save(19, { hipId: "IN3610005555" }, null), /still open as HIU IN3610001174/);
    // Setting the HIU id to the one it already asks as is not.
    await directory.save(19, { hipId: "IN3610005555", hiuId: "IN3610001174" }, null);

    // Once settled, the id can change; open requests of another hospital never block this one.
    openRequests.clear();
    openRequests.set("21|IN3610003333", 5);
    await directory.save(20, { hipId: "IN3610002222", hiuId: "IN3610009999" }, null);
    assert.equal((await directory.hiu(20))?.id, "IN3610009999");
});

test("a list read that started before a save never puts the old facilities back in the cache", async () => {
    let releaseFirst: () => void = () => {};
    let reads = 0;
    const slow: FacilityStore = {
        async list() {
            const before = await store.list();
            if (++reads === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
            return before;
        },
        save: store.save,
    };
    const raced = new AbdmFacilityDirectory(slow);
    const inFlight = raced.all();                                   // a callback reads, with the old ids
    await new Promise((resolve) => setImmediate(resolve));
    await raced.save(19, { hipId: "IN3610001174", hiuId: "IN3610005555" }, null);   // the admin moves 19's HIU id
    releaseFirst();
    assert.equal((await inFlight).find((f) => f.hospitalId === 19)?.hiuId, null, "the caller that read first still gets what it read");
    assert.equal((await raced.hiu(19))?.id, "IN3610005555", "but the next read is fresh, not the pre-save list");
    assert.equal(await raced.hiuById("IN3610001174"), null);
});
