import { test } from "node:test";
import assert from "node:assert/strict";
import { errorCodeOf } from "../Abdm/hiu/hiu-db-errors.js";
import { LARGE_WRITE_LOCK, LargeWriteLockError } from "../../repositories/Abdm/hiu-data.repository.js";
import {
    BATCH_CHARS, convertHiuRecordContent, copyBatchStatement, measureHiuRecords, measureSettled, PENDING_COLUMN, swapStatement,
} from "./hiu-record-content.migration.js";

/**
 * A query stub that answers each statement by its kind: the state read ([state]), a copy batch
 * ([batches], in order; then none left), the swap ([swap]), and anything else (ALTER, DROP) with [].
 */
const runWith = (options: {
    state: { ContentType: string | null; PendingType: string | null };
    batches?: any[];
    swap?: any[];
}) => {
    const sent: string[] = [];
    const batches = [...(options.batches ?? [])];
    const swaps = [...(options.swap ?? [{ LockResult: 0, CaughtUp: 0, Remaining: 0 }])];
    const run = async (statement: string) => {
        sent.push(statement);
        if (statement.startsWith("SELECT\n    (SELECT TYPE_NAME")) return [options.state];
        if (statement.includes("DECLARE @batch")) return [batches.shift() ?? { LockResult: 0, Copied: 0, Skipped: 0, LastId: null }];
        if (statement.includes("sp_rename")) return [swaps.shift() ?? { LockResult: 0, CaughtUp: 0, Remaining: 0 }];
        return [];
    };
    const kinds = () => sent.map((statement) =>
        statement.startsWith("SELECT\n    (SELECT TYPE_NAME") ? "state"
            : statement.includes("DECLARE @batch") ? `copy after ${/WHERE Id > (\d+)/.exec(statement)![1]}`
                : statement.includes("sp_rename") ? "swap"
                    : statement.startsWith(`ALTER TABLE dbo.AbdmHiuRecords ADD ${PENDING_COLUMN} `) ? `add ${statement.slice(`ALTER TABLE dbo.AbdmHiuRecords ADD ${PENDING_COLUMN} `.length, -" NULL;".length)}`
                        : statement.includes(`DROP COLUMN ${PENDING_COLUMN}`) ? "drop pending"
                            : statement);
    return { run, sent, kinds };
};

const quiet = { log: () => undefined };

test("up adds ContentNew as VARCHAR, copies in batches from Id to Id until none is left, then swaps", async () => {
    const { run, kinds, sent } = runWith({
        state: { ContentType: "nvarchar", PendingType: null },
        batches: [
            { LockResult: 0, Copied: 3, Skipped: 0, LastId: 3 },
            { LockResult: 0, Copied: 4, Skipped: 0, LastId: 9 },
        ],
        swap: [{ LockResult: 0, CaughtUp: 1, Remaining: 0 }],
    });
    assert.deepEqual(await convertHiuRecordContent(run, "varchar", quiet), { converted: true, copied: 8, abandoned: null });
    assert.deepEqual(kinds(), ["state", "add VARCHAR(MAX)", "copy after 0", "copy after 3", "copy after 9", "swap"]);
    // NVARCHAR's DATALENGTH is two bytes a character.
    assert.match(sent[2], new RegExp(`Running <= ${2 * BATCH_CHARS};`));
});

test("down adds ContentNew as NVARCHAR, with the batch budget in VARCHAR's bytes and no ASCII check", async () => {
    const { run, kinds, sent } = runWith({ state: { ContentType: "varchar", PendingType: null } });
    assert.deepEqual(await convertHiuRecordContent(run, "nvarchar", { ...quiet, batchChars: 1000 }), { converted: true, copied: 0, abandoned: null });
    assert.deepEqual(kinds(), ["state", "add NVARCHAR(MAX)", "copy after 0", "swap"]);
    assert.match(sent[2], /Running <= 1000;/);
    assert.ok(!sent[2].includes("NOT LIKE"));
    assert.ok(!sent[3].includes("NOT LIKE"));
});

test("an unfinished conversion the same way is resumed: no column is added, and copying starts from the first Id", async () => {
    const { run, kinds } = runWith({
        state: { ContentType: "nvarchar", PendingType: "varchar" },
        batches: [{ LockResult: 0, Copied: 2, Skipped: 0, LastId: 40 }],
    });
    const lines: string[] = [];
    assert.deepEqual(await convertHiuRecordContent(run, "varchar", { log: (line) => lines.push(line) }), { converted: true, copied: 2, abandoned: null });
    assert.deepEqual(kinds(), ["state", "copy after 0", "copy after 40", "swap"]);
    assert.equal(lines[0], "Resuming the conversion to VARCHAR(MAX).");
});

test("nothing is converted when Content has the type already; an unfinished conversion the other way is dropped", async () => {
    const done = runWith({ state: { ContentType: "varchar", PendingType: null } });
    assert.deepEqual(await convertHiuRecordContent(done.run, "varchar", quiet), { converted: false, copied: 0, abandoned: null });
    assert.deepEqual(done.kinds(), ["state"]);

    // down while an up is half done: its column goes, Content (still NVARCHAR) is untouched.
    const halfUp = runWith({ state: { ContentType: "nvarchar", PendingType: "varchar" } });
    assert.deepEqual(await convertHiuRecordContent(halfUp.run, "nvarchar", quiet), { converted: false, copied: 0, abandoned: "varchar" });
    assert.deepEqual(halfUp.kinds(), ["state", "drop pending"]);
});

test("a row VARCHAR would change stops the conversion before the swap: the half-filled column is dropped, Content kept", async () => {
    const { run, kinds } = runWith({
        state: { ContentType: "nvarchar", PendingType: null },
        batches: [{ LockResult: 0, Copied: 4, Skipped: 1, LastId: 5 }],
    });
    await assert.rejects(convertHiuRecordContent(run, "varchar", quiet), /^Error: 1 record\(s\) hold characters VARCHAR\(MAX\) would not keep; Content is unchanged\.$/);
    assert.deepEqual(kinds(), ["state", "add VARCHAR(MAX)", "copy after 0", "copy after 5", "drop pending"]);
});

test("a row that came in during the copy and would not survive stops the swap (rolled back), and the column is dropped", async () => {
    const { run, kinds } = runWith({
        state: { ContentType: "nvarchar", PendingType: null },
        swap: [{ LockResult: 0, CaughtUp: 2, Remaining: 1 }],
    });
    await assert.rejects(convertHiuRecordContent(run, "varchar", quiet), /1 record\(s\) hold characters/);
    assert.deepEqual(kinds(), ["state", "add VARCHAR(MAX)", "copy after 0", "swap", "drop pending"]);
});

test("a step asks for the large-write lock again while a write holds it, and fails past the wait or on any other refusal", async () => {
    let now = 0;
    const waiting = runWith({
        state: { ContentType: "nvarchar", PendingType: null },
        batches: [{ LockResult: -1 }, { LockResult: -1 }, { LockResult: 0, Copied: 1, Skipped: 0, LastId: 1 }],
    });
    const result = await convertHiuRecordContent(waiting.run, "varchar", { ...quiet, clock: () => (now += 1_000), lockWaitMs: 60_000 });
    assert.equal(result.copied, 1);
    assert.deepEqual(waiting.kinds(), ["state", "add VARCHAR(MAX)", "copy after 0", "copy after 0", "copy after 0", "copy after 1", "swap"]);

    const held = runWith({ state: { ContentType: "nvarchar", PendingType: null }, swap: [{ LockResult: -1 }, { LockResult: -1 }] });
    now = 0;
    await assert.rejects(
        convertHiuRecordContent(held.run, "varchar", { ...quiet, clock: () => (now += 40_000), lockWaitMs: 60_000 }),
        (error: any) => error instanceof LargeWriteLockError && errorCodeOf(error) === "ELOCKWAIT",
    );

    const refused = runWith({ state: { ContentType: "nvarchar", PendingType: null }, batches: [{ LockResult: -3 }] });
    await assert.rejects(convertHiuRecordContent(refused.run, "varchar", quiet), (error: any) => errorCodeOf(error) === "ELOCKREFUSED");
});

test("a missing table is an error, not a conversion", async () => {
    const { run } = runWith({ state: { ContentType: null, PendingType: null } });
    await assert.rejects(convertHiuRecordContent(run, "varchar", quiet), /Content does not exist/);
});

test("each batch and the swap run in a transaction holding the large-write lock; VARCHAR takes printable ASCII only", () => {
    const copy = copyBatchStatement("varchar", 12, 4096);
    assert.match(copy, /^SET XACT_ABORT ON;\nSET NOCOUNT ON;\nBEGIN TRANSACTION;/);
    assert.ok(copy.includes(`sp_getapplock @Resource = '${LARGE_WRITE_LOCK}', @LockMode = 'Exclusive', @LockOwner = 'Transaction'`));
    assert.ok(copy.includes("WHERE Id > 12"));
    assert.ok(copy.includes(`SET ${PENDING_COLUMN} = CAST(r.Content AS VARCHAR(MAX))`));
    assert.ok(copy.includes("r.Content COLLATE Latin1_General_100_BIN2 NOT LIKE N'%[^ -~]%'"));
    assert.match(copy, /COMMIT TRANSACTION;$/);

    const swap = swapStatement("varchar");
    assert.ok(swap.includes("WITH (TABLOCKX, HOLDLOCK)"));
    assert.match(swap, /IF @remaining > 0\s+BEGIN\s+ROLLBACK TRANSACTION;/);
    assert.match(swap, /ALTER TABLE dbo\.AbdmHiuRecords DROP COLUMN Content;\s+EXEC sp_rename N'dbo\.AbdmHiuRecords\.ContentNew', N'Content', N'COLUMN';\s+COMMIT TRANSACTION;/);
});

test("measure: content bytes and records, the unfinished conversion's progress, and reserved space when readable", async () => {
    const sent: string[] = [];
    const size = await measureHiuRecords(async (statement) => {
        sent.push(statement);
        if (statement.startsWith("SELECT\n    (SELECT TYPE_NAME")) return [{ ContentType: "nvarchar", PendingType: "varchar" }];
        if (statement.includes("dm_db_partition_stats")) throw Object.assign(new Error("VIEW DATABASE STATE permission denied"), { number: 297 });
        return [{ Records: "10", WithContent: 8, ContentBytes: "16000", PendingCopied: 3 }];
    });
    assert.deepEqual(size, { contentType: "nvarchar", pendingType: "varchar", records: 10, withContent: 8, contentBytes: 16000, pendingCopied: 3, reservedBytes: null });
    assert.ok(sent[1].includes(`COUNT_BIG(${PENDING_COLUMN}) AS PendingCopied`));
});

test("after a reclaim, the size is read once the freed pages have left: when the reserved space has fallen and holds still", async () => {
    const reserved = [900, 900, 600, 400, 400, 300];
    const slept: number[] = [];
    const size = await measureSettled(async (statement) => {
        if (statement.startsWith("SELECT\n    (SELECT TYPE_NAME")) return [{ ContentType: "varchar", PendingType: null }];
        if (statement.includes("dm_db_partition_stats")) return [{ ReservedBytes: reserved.shift() }];
        return [{ Records: 2, WithContent: 2, ContentBytes: 10 }];
    }, { pollMs: 5, maxWaitMs: 100, sleep: async (ms) => { slept.push(ms); } });
    assert.equal(size.reservedBytes, 400, "not 900 (before the pages went) nor a wait past the settle");
    assert.deepEqual(slept, [5, 5, 5, 5]);

    // Never falling (nothing to give back) is waited out once, then answered.
    const still = await measureSettled(async (statement) =>
        statement.includes("dm_db_partition_stats") ? [{ ReservedBytes: 500 }] : statement.startsWith("SELECT\n    (SELECT TYPE_NAME") ? [{ ContentType: "varchar", PendingType: null }] : [{ Records: 1 }],
    { pollMs: 10, maxWaitMs: 30, sleep: async () => undefined });
    assert.equal(still.reservedBytes, 500);
});
