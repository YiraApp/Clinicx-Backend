import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { HiuAuditEventInput } from "./hiu-audit.js";
import { HiuMaintenanceService, type HiuMaintenanceStore } from "./hiu-maintenance.service.js";

const NOW = new Date("2026-10-26T10:00:00.000Z");

let steps: string[];
let failed: number[];
let audits: HiuAuditEventInput[];
let faults: Set<string>;
let logged: string[];
const originalLog = { log: console.log, error: console.error };

const store: HiuMaintenanceStore = {
    async purgeRecords(now) {
        steps.push(`purge ${now.toISOString()}`);
        if (faults.has("purge")) throw Object.assign(new Error("db down"), { code: "ETIMEOUT" });
        return [
            { artefactFk: 1, hospitalId: 7, consentArtefactId: "art-1", count: 3 },
            { artefactFk: 2, hospitalId: 8, consentArtefactId: "art-2", count: 1 },
        ];
    },
    async listTimedOutTransfers(now, limit) {
        steps.push(`timeouts ${limit}`);
        return [11, 12];
    },
    async closeStaleClaimed() {
        steps.push("stale");
        return 0;
    },
    async clearPrivateKeys(now) {
        steps.push(`keys ${now.toISOString()}`);
        return 2;
    },
};

const dataFlow = {
    async failTransfer(id: number) {
        failed.push(id);
    },
};

const audit = { async record(event: HiuAuditEventInput) { audits.push(event); } };

beforeEach(() => {
    steps = [];
    failed = [];
    audits = [];
    faults = new Set();
    logged = [];
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
});

afterEach(() => {
    Object.assign(console, originalLog);
});

test("one sweep purges due records with an audit per artefact, fails timed-out transfers, closes stale ones and drops keys", async () => {
    const service = new HiuMaintenanceService({ store, dataFlow, audit });
    await service.runOnce(NOW);

    assert.deepEqual(steps, [`purge ${NOW.toISOString()}`, "timeouts 50", "stale", `keys ${NOW.toISOString()}`]);
    assert.deepEqual(failed, [11, 12]);
    assert.deepEqual(audits.map((event) => [event.event, event.hospitalId, event.artefactId, event.outcome, event.detail]), [
        ["RECORD_PURGED", 7, "art-1", "OK", "3 records"],
        ["RECORD_PURGED", 8, "art-2", "OK", "1 records"],
    ]);
    assert.ok(logged.some((line) => line.includes("4 records deleted from 2 artefacts")));
});

test("with the consent service, the sweep also fails requests with no on-init and fetches stuck artefacts again", async () => {
    const consent = {
        async failStaleSending(now: number) {
            steps.push(`stale-sending ${new Date(now).toISOString()}`);
            if (faults.has("stale-sending")) throw Object.assign(new Error("db down"), { code: "ETIMEOUT" });
            return 1;
        },
        async retryFetches(now: number) {
            steps.push(`refetch ${new Date(now).toISOString()}`);
            return 2;
        },
    };
    const service = new HiuMaintenanceService({ store, dataFlow, consent, audit });
    await service.runOnce(NOW);
    assert.deepEqual(steps.slice(-2), [`stale-sending ${NOW.toISOString()}`, `refetch ${NOW.toISOString()}`]);
    assert.ok(logged.some((line) => line.includes("1 consent requests with no on-init marked failed")));
    assert.ok(logged.some((line) => line.includes("2 consent artefacts fetched again")));

    steps = [];
    faults.add("stale-sending");
    await service.runOnce(NOW);
    assert.equal(steps.at(-1), `refetch ${NOW.toISOString()}`, "a failing step does not stop the re-fetch");
});

test("a failing step is logged by code and the other steps still run", async () => {
    faults.add("purge");
    const service = new HiuMaintenanceService({ store, dataFlow, audit });
    await service.runOnce(NOW);
    assert.deepEqual(failed, [11, 12]);
    assert.ok(steps.includes(`keys ${NOW.toISOString()}`));
    assert.ok(logged.some((line) => line.includes('"purge records" failed: ETIMEOUT')));
    assert.ok(!logged.some((line) => line.includes("db down")));
});

test("runOnce without a time uses the injected clock", async () => {
    const service = new HiuMaintenanceService({ store, dataFlow, audit, clock: () => NOW.getTime() });
    await service.runOnce();
    assert.equal(steps[0], `purge ${NOW.toISOString()}`);
});

test("start runs on an unref'd interval and the returned function stops it", async () => {
    const realSetInterval = globalThis.setInterval;
    let unrefCalled = false;
    let interval = 0;
    let tick: (() => void) | null = null;
    (globalThis as any).setInterval = (fn: () => void, ms: number) => {
        tick = fn;
        interval = ms;
        const timer = realSetInterval(() => {}, 1_000_000);
        const unref = timer.unref.bind(timer);
        timer.unref = () => { unrefCalled = true; return unref(); };
        return timer;
    };
    try {
        const service = new HiuMaintenanceService({ store, dataFlow, audit, clock: () => NOW.getTime() });
        const stop = service.start();
        assert.equal(interval, 60_000);
        assert.ok(unrefCalled);
        // A tick while the previous sweep still runs does not start a second one.
        tick!();
        tick!();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(steps.filter((step) => step.startsWith("purge")).length, 1);
        stop();
    } finally {
        globalThis.setInterval = realSetInterval;
    }
});
