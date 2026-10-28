import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MssqlParameter } from "typeorm/index.js";
import { HiuError } from "../../services/Abdm/hiu/hiu-enums.js";
import { errorCodeOf, isTransientSqlError, RecordPurgeError, TRANSIENT_RETRY_DELAYS_MS as RETRY_DELAYS } from "../../services/Abdm/hiu/hiu-db-errors.js";
import { HiuDataRepository, isDuplicateKeyError, PURGE_SWEEP_BUDGET_MS, toDataRequestRow } from "./hiu-data.repository.js";

type Sent = { sql: string; parameters: unknown[] };

/**
 * A repository over a stub query that records each statement and answers with [answer] (it may
 * throw, or return a promise). Like TypeORM's SqlServerQueryRunner, a statement whose first word is
 * DELETE is answered [recordset, rowsAffected], not the recordset alone. Waits between tries are
 * recorded in [slept], not waited.
 */
const repositoryWith = (answer: (sent: Sent) => any, options: { clock?: () => number } = {}) => {
    const sent: Sent[] = [];
    const slept: number[] = [];
    const repository = new HiuDataRepository({
        query: async (sql, parameters = []) => {
            const item = { sql, parameters };
            sent.push(item);
            const result = await answer(item);
            return sql.slice(0, sql.indexOf(" ")) === "DELETE" ? [result, Array.isArray(result) ? result.length : 0] : result;
        },
        sleep: async (ms) => { slept.push(ms); },
        // The middle of the jitter: each wait is its delay exactly.
        random: () => 0.5,
        ...options,
    });
    return { repository, sent, slept };
};

const duplicateKey = () => Object.assign(new Error("Violation of UNIQUE KEY constraint"), { driverError: { number: 2627 } });
/** What TypeORM throws when mssql's requestTimeout passes: the driver's code copied onto the error. */
const timedOut = () => Object.assign(new Error("Timeout: Request failed to complete in 30000ms"), { code: "ETIMEOUT", driverError: { code: "ETIMEOUT" } });
const onePage = { dataRequestId: 9, artefactFk: 2, hospitalId: 7, pageNumber: 1, records: [{ entryIndex: 0, careContextReference: null, media: null, checksumOk: true, content: "c", deleteAt: null }] };

let logged: string[];
const originalWarn = console.warn;
beforeEach(() => {
    logged = [];
    console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
});
afterEach(() => {
    console.warn = originalWarn;
});

test("transient SQL errors are recognised: timeouts, lost connections, deadlocks, lock timeouts, Azure busy; nothing else", () => {
    assert.equal(isTransientSqlError(timedOut()), true);
    assert.equal(isTransientSqlError({ code: "ESOCKET" }), true);
    assert.equal(isTransientSqlError({ driverError: { number: 1205 } }), true);
    assert.equal(isTransientSqlError({ number: 1222 }), true);
    assert.equal(isTransientSqlError({ originalError: { info: { number: 40501 } } }), true);
    assert.equal(isTransientSqlError({ driverError: { number: 2627 } }), false, "a duplicate is an answer, not a fault");
    assert.equal(isTransientSqlError({ driverError: { number: 50001 } }), false, "a closed transfer is an answer");
    assert.equal(isTransientSqlError({ code: "EREQUEST", number: 245 }), false);
    assert.equal(isTransientSqlError({ code: "ECLOSE", number: "ECLOSE" }), true, "a connection closed mid-request");
    assert.equal(isTransientSqlError(null), false);
});

test("an error is shown by SQL Server's number, else the driver's code; never its message", () => {
    assert.equal(errorCodeOf({ code: "EREQUEST", number: 1205, message: "Transaction (Process ID 61) was deadlocked" }), "1205");
    assert.equal(errorCodeOf(timedOut()), "ETIMEOUT");
    assert.equal(errorCodeOf({ code: "ETIMEOUT", number: "ETIMEOUT" }), "ETIMEOUT");
    assert.equal(errorCodeOf(new RecordPurgeError(3, timedOut())), "RecordPurgeError");
    assert.equal(errorCodeOf(null), "error");
});

test("duplicate-key errors are recognised in the shapes TypeORM and mssql raise", () => {
    assert.equal(isDuplicateKeyError({ number: 2627 }), true);
    assert.equal(isDuplicateKeyError({ driverError: { number: 2601 } }), true);
    assert.equal(isDuplicateKeyError({ originalError: { info: { number: 2627 } } }), true);
    assert.equal(isDuplicateKeyError({ number: 1205 }), false);
    assert.equal(isDuplicateKeyError(null), false);
});

test("a data request row maps to the store's shape", () => {
    const row = toDataRequestRow({
        Id: 4, HiRequestId: "req", TransactionId: null, ArtefactFk: 2, HospitalId: 7,
        DateFrom: new Date("2024-01-01T00:00:00.000Z"), DateTo: new Date("2025-01-01T00:00:00.000Z"),
        PushTokenHash: "ab".repeat(32) + "  ", PrivateKey: "hiu1:k1:x:y", Nonce: "n", KeyExpiresAt: new Date("2026-10-26T10:30:00.000Z"),
        TransferDeadline: null, SessionStatus: "RECEIVING", PageCount: 3, PagesReceived: 2, CareContextStatus: null,
        NotifiedAt: null, NotifyRequestId: null, Error: null, CreatedAt: new Date(), CompletedAt: null,
    });
    assert.equal(row.pushTokenHash, "ab".repeat(32), "CHAR padding is trimmed");
    assert.equal(row.pageCount, 3);
    assert.equal(row.pagesReceived, 2);
    assert.equal(row.transferDeadline, null);
    assert.equal(row.sessionStatus, "RECEIVING");
});

test("a page is inserted whole in one transaction with the PagesReceived increment", async () => {
    const { repository, sent } = repositoryWith(() => [{ PagesReceived: 2 }]);
    const deleteAt = new Date("2026-12-31T00:00:00.123Z");
    const result = await repository.addPage({
        dataRequestId: 9, artefactFk: 2, hospitalId: 7, pageNumber: 1,
        records: [
            { entryIndex: 0, careContextReference: "sealed-a", media: "application/fhir+json", checksumOk: true, content: "sealed-c", deleteAt },
            { entryIndex: 1, careContextReference: "sealed-b", media: "application/fhir+json", checksumOk: false, content: null, deleteAt },
        ],
    });
    assert.deepEqual(result, { duplicate: false, pagesReceived: 2 });
    const { sql, parameters } = sent[0];
    // A lock-free check first, so a page queued behind a revocation or a close writes nothing.
    assert.match(sql, /^SET XACT_ABORT ON;\s+IF NOT EXISTS \(SELECT 1 FROM AbdmHiuConsentArtefacts WHERE Id = @1 AND Status = 'GRANTED' AND RecordsPurgedAt IS NULL\)\s+OR NOT EXISTS \(SELECT 1 FROM AbdmHiuDataRequests WHERE Id = @0 AND NotifiedAt IS NULL AND SessionStatus IN \('REQUESTED', 'RECEIVING'\) AND PrivateKey IS NOT NULL\)\s+THROW 50001, [^;]+;\s+BEGIN TRANSACTION;\s+INSERT INTO AbdmHiuRecords /);
    assert.match(sql, /PagesReceived = PagesReceived \+ 1 OUTPUT inserted\.PagesReceived/);
    assert.match(sql, /THROW 50001, 'The transfer has ended\.', 1;\s+COMMIT TRANSACTION;$/);
    assert.deepEqual(parameters.slice(0, 2), [9, 2]);
    assert.equal(parameters.length, 2 + 2 * 11);
    assert.ok(sql.includes("(@2, @3, @4, @5, @6, @7, @8, @9, @10, @11, @12), (@13,"));
    const boundDeleteAt = parameters[11] as MssqlParameter;
    assert.ok(boundDeleteAt instanceof MssqlParameter);
    assert.equal(boundDeleteAt.type, "datetime2");
    assert.equal((boundDeleteAt.value as Date).getTime(), deleteAt.getTime());
});

test("a page is kept only under a granted, unpurged artefact and an open transfer, checked after the insert; else it is reported closed", async () => {
    const { repository, sent } = repositoryWith(() => [{ PagesReceived: 1 }]);
    await repository.addPage({ dataRequestId: 9, artefactFk: 2, hospitalId: 7, pageNumber: 1, records: [{ entryIndex: 0, careContextReference: null, media: null, checksumOk: true, content: "c", deleteAt: null }] });
    const { sql } = sent[0];
    const artefactCheck = sql.search(/FROM AbdmHiuConsentArtefacts WITH \(UPDLOCK, HOLDLOCK\)\s+WHERE Id = @1 AND Status = 'GRANTED' AND RecordsPurgedAt IS NULL/);
    const update = sql.indexOf("UPDATE AbdmHiuDataRequests");
    const insert = sql.indexOf("INSERT INTO AbdmHiuRecords");
    // No lock on the artefact row while megabytes are written: a revocation never waits on the insert.
    assert.ok(insert > 0 && insert < artefactCheck && artefactCheck < update, "the insert, then the artefact locked, then the transfer");
    assert.match(sql, /WHERE Id = @0 AND NotifiedAt IS NULL AND SessionStatus IN \('REQUESTED', 'RECEIVING'\) AND PrivateKey IS NOT NULL;\s+IF @@ROWCOUNT = 0\s+THROW 50001/);

    const closed = repositoryWith(() => { throw Object.assign(new Error("The transfer has ended."), { driverError: { number: 50001 } }); });
    assert.deepEqual(
        await closed.repository.addPage({ dataRequestId: 9, artefactFk: 2, hospitalId: 7, pageNumber: 1, records: [{ entryIndex: 0, careContextReference: null, media: null, checksumOk: true, content: "c", deleteAt: null }] }),
        { duplicate: false, closed: true, pagesReceived: 0 },
    );
});

test("a refused request is failed only while nothing has answered it; bytes are reserved only within the cap", async () => {
    let rows: any[] = [{ Id: 9 }];
    const { repository, sent } = repositoryWith(() => rows);
    assert.equal(await repository.failUnansweredRequest(9, { at: new Date("2026-10-26T10:00:00.000Z"), error: "refused" }), true);
    assert.match(sent[0].sql, /SET SessionStatus = 'FAILED', PrivateKey = NULL/);
    assert.match(sent[0].sql, /WHERE Id = @0 AND TransactionId IS NULL AND SessionStatus = 'REQUESTED' AND NotifiedAt IS NULL/);
    assert.equal(await repository.reserveBytes(9, 500, 1_000), true);
    assert.match(sent[1].sql, /WHERE Id = @0 AND BytesReceived \+ @1 <= @2/);
    assert.deepEqual(sent[1].parameters, [9, 500, 1_000]);
    rows = [];
    assert.equal(await repository.failUnansweredRequest(9, { at: new Date(), error: "refused" }), false);
    assert.equal(await repository.reserveBytes(9, 500, 1_000), false);
});

test("a second open transfer for one artefact (the unique index) is a conflict", async () => {
    const { repository } = repositoryWith(() => { throw duplicateKey(); });
    await assert.rejects(repository.createDataRequest({
        hiRequestId: "r", artefactFk: 2, hospitalId: 7, dateFrom: new Date(), dateTo: new Date(), pushTokenHash: "ab".repeat(32),
        privateKey: "k", nonce: "n", keyExpiresAt: new Date(), transferDeadline: new Date(), sessionStatus: "REQUESTED",
    }), (error: any) => error instanceof HiuError && error.kind === "conflict");
});

test("the records list sends content only within its byte budget; one record is read by id under its artefact", async () => {
    const { repository, sent } = repositoryWith(() => [
        { Id: 1, DataRequestFk: 3, PageNumber: 1, EntryIndex: 0, CareContextReference: "s", Media: "m", ChecksumOk: true, Content: "c", ReceivedAt: new Date(), DeleteAt: null, ContentOmitted: false },
        { Id: 2, DataRequestFk: 3, PageNumber: 1, EntryIndex: 1, CareContextReference: "s", Media: "m", ChecksumOk: true, Content: null, ReceivedAt: new Date(), DeleteAt: null, ContentOmitted: 1 },
    ]);
    const rows = await repository.listRecords(2, new Date(), 1_000);
    assert.deepEqual(rows.map((row) => [row.content, row.contentOmitted]), [["c", false], [null, true]]);
    assert.match(sent[0].sql, /SUM\(CAST\(ISNULL\(DATALENGTH\(Content\), 0\) AS BIGINT\)\) OVER \(ORDER BY DataRequestFk, PageNumber, EntryIndex, Id ROWS UNBOUNDED PRECEDING\)/);
    assert.match(sent[0].sql, /CASE WHEN Running <= @2 THEN Content ELSE NULL END AS Content/);
    assert.equal(sent[0].parameters[2], 1_000);

    await repository.findRecord(2, 5, new Date());
    assert.match(sent[1].sql, /WHERE Id = @0 AND ArtefactFk = @1 AND EntryIndex >= 0/);
    assert.deepEqual(sent[1].parameters.slice(0, 2), [5, 2]);
});

test("records are read from one transfer of the artefact only: its latest RECEIVED one with entries, else its latest with entries", async () => {
    const { repository, sent } = repositoryWith(() => []);
    await repository.listRecords(2, new Date(), 1_000);
    await repository.findRecord(2, 5, new Date());
    const shown = (artefact: string) => new RegExp(
        String.raw`AND DataRequestFk = \(SELECT TOP 1 dr\.Id FROM AbdmHiuDataRequests dr\s+WHERE dr\.ArtefactFk = ${artefact}\s+`
        + String.raw`AND EXISTS \(SELECT 1 FROM AbdmHiuRecords x WHERE x\.DataRequestFk = dr\.Id AND x\.EntryIndex >= 0\)\s+`
        + String.raw`ORDER BY CASE WHEN dr\.SessionStatus = 'RECEIVED' THEN 0 ELSE 1 END, dr\.Id DESC\)`,
    );
    assert.match(sent[0].sql, shown("@0"), "the list: artefact @0");
    assert.match(sent[1].sql, shown("@1"), "one record: artefact @1");
});

test("a RECEIVED transfer holding entries is reported, so the artefact is not asked for twice", async () => {
    let rows: any[] = [{ Id: 4 }];
    const { repository, sent } = repositoryWith(() => rows);
    assert.equal(await repository.hasReceivedRecords(2), true);
    assert.match(sent[0].sql, /WHERE dr\.ArtefactFk = @0 AND dr\.SessionStatus = 'RECEIVED'\s+AND EXISTS \(SELECT 1 FROM AbdmHiuRecords rec WHERE rec\.DataRequestFk = dr\.Id AND rec\.EntryIndex >= 0\)/);
    assert.deepEqual(sent[0].parameters, [2]);
    rows = [];
    assert.equal(await repository.hasReceivedRecords(2), false);
});

test("a page already stored is reported as a duplicate, not an error", async () => {
    const { repository } = repositoryWith(() => { throw duplicateKey(); });
    assert.deepEqual(
        await repository.addPage({ dataRequestId: 9, artefactFk: 2, hospitalId: 7, pageNumber: 1, records: [{ entryIndex: 0, careContextReference: null, media: null, checksumOk: false, content: null, deleteAt: null }] }),
        { duplicate: true, pagesReceived: 0, afterRetry: false },
    );
    const failing = repositoryWith(() => { throw Object.assign(new Error("deadlock"), { code: "EREQUEST", number: 1205 }); });
    await assert.rejects(failing.repository.addPage({ dataRequestId: 9, artefactFk: 2, hospitalId: 7, pageNumber: 1, records: [] }), /deadlock/);
    assert.equal(failing.sent.length, RETRY_DELAYS.length + 1, "a deadlock is tried again, then thrown");
    assert.deepEqual(failing.slept, RETRY_DELAYS);
    assert.equal(logged[0], "[ABDM HIU] data push page 1: 1205, trying again (2 of 4)", "logged by SQL Server's number, not EREQUEST");

    const refused = repositoryWith(() => { throw Object.assign(new Error("Conversion failed"), { code: "EREQUEST", number: 245 }); });
    await assert.rejects(refused.repository.addPage(onePage), /Conversion failed/);
    assert.equal(refused.sent.length, 1, "an error that is not transient is not tried again");
});

test("a page store that times out is tried again after a wait, and the answer of the try that lands is returned", async () => {
    let tries = 0;
    const { repository, sent, slept } = repositoryWith(() => {
        tries += 1;
        if (tries === 1) throw timedOut();
        if (tries === 2) throw Object.assign(new Error("deadlock"), { code: "EREQUEST", number: 1205 });
        return [{ PagesReceived: 4 }];
    });
    assert.deepEqual(await repository.addPage(onePage), { duplicate: false, pagesReceived: 4 });
    assert.equal(sent.length, 3);
    assert.equal(sent[2].sql, sent[0].sql, "the same whole-page transaction each time");
    assert.deepEqual(slept, RETRY_DELAYS.slice(0, 2));
    assert.deepEqual(logged, [
        "[ABDM HIU] data push page 1: ETIMEOUT, trying again (2 of 4)",
        "[ABDM HIU] data push page 1: 1205, trying again (3 of 4)",
    ]);
});

test("a statement that runs its whole timeout is tried once more only: one too large to finish in time does not hold the queue", async () => {
    const { repository, sent } = repositoryWith(() => { throw timedOut(); });
    await assert.rejects(repository.addPage(onePage), /Timeout/);
    assert.equal(sent.length, 2);
});

test("a try that committed but timed out before its answer meets the unique index next time and is reported a duplicate of its own", async () => {
    let tries = 0;
    const { repository } = repositoryWith(() => {
        tries += 1;
        if (tries === 1) throw timedOut();
        throw duplicateKey();
    });
    assert.deepEqual(await repository.addPage(onePage), { duplicate: true, pagesReceived: 0, afterRetry: true });
});

test("large writes run one at a time: a second page's insert starts only when the first has finished", async () => {
    let release: () => void = () => {};
    const first = new Promise<void>((resolve) => { release = resolve; });
    const { repository, sent } = repositoryWith(async ({ parameters }) => {
        if (parameters[0] === 9) await first;
        return [{ PagesReceived: 1 }];
    });
    const one = repository.addPage(onePage);
    const two = repository.addPage({ ...onePage, dataRequestId: 10, pageNumber: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1, "the second waits while the first runs");
    release();
    await Promise.all([one, two]);
    assert.deepEqual(sent.map((item) => item.parameters[0]), [9, 10]);

    // A failed write does not stop the queue.
    let fail = true;
    const after = repositoryWith(() => {
        if (fail) { fail = false; throw Object.assign(new Error("bad"), { number: 245 }); }
        return [{ PagesReceived: 1 }];
    });
    await assert.rejects(after.repository.addPage(onePage));
    assert.deepEqual(await after.repository.addPage(onePage), { duplicate: false, pagesReceived: 1 });
});

test("record deletes share the page stores' queue: a purge waits while a page is being written", async () => {
    let release: () => void = () => {};
    const pageWrite = new Promise<void>((resolve) => { release = resolve; });
    let rows = 1;
    const { repository, sent } = repositoryWith(async ({ sql }) => {
        if (sql.startsWith("SET XACT_ABORT ON")) { await pageWrite; return [{ PagesReceived: 1 }]; }
        if (sql.startsWith("DELETE")) return rows-- > 0 ? [{ Id: 1 }] : [];
        return [];
    });
    const page = repository.addPage(onePage);
    const purge = repository.purgeArtefactRecords(2, new Date());
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.map((item) => item.sql.slice(0, 6)), ["SET XA"], "no delete while the page is written");
    release();
    assert.equal(await purge, 1);
    await page;
    assert.equal(sent[1].sql.slice(0, 6), "DELETE");
});

test("an ended artefact's records are deleted one row per statement, each retried, never a granted one's; then it is stamped", async () => {
    let remaining = 3;
    let timeouts = 1;
    const { repository, sent, slept } = repositoryWith(({ sql }) => {
        if (sql.startsWith("DELETE")) {
            if (remaining === 2 && timeouts-- > 0) throw timedOut();
            if (remaining === 0) return [];
            remaining -= 1;
            return [{ Id: remaining + 10 }];
        }
        return [];
    });
    const when = new Date("2026-10-28T06:20:41.969Z");
    assert.equal(await repository.purgeArtefactRecords(2, when), 3);
    const deletes = sent.filter((item) => item.sql.startsWith("DELETE"));
    assert.equal(deletes.length, 5, "three rows, one retry, and the empty one that ends it");
    for (const { sql, parameters } of deletes) {
        assert.match(sql, /^DELETE TOP \(1\) rec\s+OUTPUT deleted\.Id\s+FROM AbdmHiuRecords rec\s+INNER JOIN AbdmHiuConsentArtefacts a ON a\.Id = rec\.ArtefactFk\s+WHERE rec\.ArtefactFk = @0 AND a\.Status <> 'GRANTED'$/);
        assert.deepEqual(parameters, [2]);
    }
    assert.deepEqual(slept, [RETRY_DELAYS[0]]);
    const stamp = sent.at(-1)!;
    assert.match(stamp.sql, /UPDATE AbdmHiuConsentArtefacts SET RecordsPurgedAt = @1\s+WHERE Id = @0 AND Status <> 'GRANTED' AND RecordsPurgedAt IS NULL\s+AND NOT EXISTS \(SELECT 1 FROM AbdmHiuRecords WHERE ArtefactFk = @0\)/);
    assert.equal(((stamp.parameters[1] as MssqlParameter).value as Date).getTime(), when.getTime());

    // An artefact with nothing stored: one empty delete, then the stamp.
    const empty = repositoryWith(() => []);
    assert.equal(await empty.repository.purgeArtefactRecords(2, when), 0);
    assert.deepEqual(empty.sent.map((item) => item.sql.slice(0, 6)), ["DELETE", "UPDATE"]);

    let left = 2;
    const stuck = repositoryWith(({ sql }) => {
        if (!sql.startsWith("DELETE")) return [];
        if (left-- > 0) return [{ Id: left }];
        throw timedOut();
    });
    await assert.rejects(stuck.repository.purgeArtefactRecords(2, when), (error: any) =>
        error instanceof RecordPurgeError && error.deleted === 2 && errorCodeOf(error.failure) === "ETIMEOUT");
    assert.ok(!stuck.sent.some((item) => item.sql.startsWith("UPDATE")), "not stamped while records remain");
});

test("a purge whose stamp still fails reports the rows it deleted; a stamp hit by a transient error is tried again", async () => {
    let stampTries = 0;
    let rows = 2;
    const busy = () => Object.assign(new Error("Database is not currently available"), { code: "EREQUEST", number: 40613 });
    const flaky = repositoryWith(({ sql }) => {
        if (sql.startsWith("DELETE")) return rows-- > 0 ? [{ Id: rows }] : [];
        if (sql.startsWith("UPDATE")) { stampTries += 1; if (stampTries === 1) throw busy(); }
        return [];
    });
    assert.equal(await flaky.repository.purgeArtefactRecords(2, new Date()), 2);
    assert.equal(stampTries, 2);

    rows = 3;
    const failing = repositoryWith(({ sql }) => {
        if (sql.startsWith("DELETE")) return rows-- > 0 ? [{ Id: rows }] : [];
        throw Object.assign(new Error("Invalid object name"), { code: "EREQUEST", number: 208 });
    });
    await assert.rejects(failing.repository.purgeArtefactRecords(2, new Date()), (error: any) =>
        error instanceof RecordPurgeError && error.deleted === 3 && errorCodeOf(error.failure) === "208");
});

test("a sweep whose stamp or name lookup fails still returns what it deleted", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    try {
        let rows = 2;
        const { repository } = repositoryWith(({ sql }) => {
            if (sql.startsWith("DELETE")) return rows-- > 0 ? [{ ArtefactFk: 6, HospitalId: 7 }] : [];
            throw Object.assign(new Error("Invalid column name"), { code: "EREQUEST", number: 207 });
        });
        assert.deepEqual(await repository.purgeRecords(new Date("2026-10-26T10:00:00.000Z")), [{ artefactFk: 6, hospitalId: 7, consentArtefactId: null, count: 2 }]);
        assert.deepEqual(errors, [
            "[ABDM HIU] maintenance: the purge stamp failed (207); the next sweep sets it",
            "[ABDM HIU] maintenance: artefact ids for the purge audit could not be read (207)",
        ]);
    } finally {
        console.error = originalError;
    }
});

test("bytes given back never take a transfer's total below zero", async () => {
    const { repository, sent } = repositoryWith(() => []);
    await repository.releaseBytes(9, 500);
    assert.match(sent[0].sql, /SET BytesReceived = CASE WHEN BytesReceived > @1 THEN BytesReceived - @1 ELSE 0 END\s+WHERE Id = @0/);
    assert.deepEqual(sent[0].parameters, [9, 500]);
});

test("records are read only while their artefact is still granted and not purged, checked in the reading statement", async () => {
    const { repository, sent } = repositoryWith(() => []);
    await repository.listRecords(2, new Date(), 1_000);
    await repository.findRecord(2, 5, new Date());
    const readable = (artefact: string) => new RegExp(String.raw`AND EXISTS \(SELECT 1 FROM AbdmHiuConsentArtefacts g WHERE g\.Id = ${artefact} AND g\.Status = 'GRANTED' AND g\.RecordsPurgedAt IS NULL\)`);
    assert.match(sent[0].sql, readable("@0"));
    assert.match(sent[1].sql, readable("@1"));
});

test("the notify claim, page-count claim and transaction adoption succeed only when a row came back", async () => {
    let rows: any[] = [{ Id: 9 }];
    const { repository, sent } = repositoryWith(() => rows);
    assert.equal(await repository.claimNotify(9, new Date(), "rid"), true);
    assert.match(sent[0].sql, /WHERE Id = @0 AND NotifiedAt IS NULL/);
    assert.equal(await repository.claimPageCount(9, 3), true);
    assert.match(sent[1].sql, /\(PageCount IS NULL OR PageCount = @1\)/);
    rows = [];
    assert.equal(await repository.claimNotify(9, new Date(), "rid"), false);
    assert.equal(await repository.claimPageCount(9, 4), false);
    assert.equal(await repository.adoptTransactionId(9, "tx"), false);
    // A transaction id is adopted only by a transfer still open: never by one failed, received or notified.
    assert.match(sent.at(-1)!.sql, /WHERE Id = @0 AND TransactionId IS NULL AND SessionStatus IN \('REQUESTED', 'RECEIVING'\) AND NotifiedAt IS NULL/);

    const taken = repositoryWith(() => { throw duplicateKey(); });
    assert.equal(await taken.repository.adoptTransactionId(9, "tx"), false);
});

test("updateDataRequest writes only the given columns, binding times as datetime2", async () => {
    const { repository, sent } = repositoryWith(() => []);
    const completedAt = new Date("2026-10-26T10:05:00.456Z");
    await repository.updateDataRequest(9, { sessionStatus: "FAILED", privateKey: null, completedAt });
    assert.equal(sent[0].sql, "UPDATE AbdmHiuDataRequests SET SessionStatus = @1, PrivateKey = @2, CompletedAt = @3 WHERE Id = @0");
    assert.equal(sent[0].parameters[0], 9);
    assert.equal(sent[0].parameters[2], null);
    assert.equal((sent[0].parameters[3] as MssqlParameter).type, "datetime2");

    await repository.updateDataRequest(9, {});
    assert.equal(sent.length, 1, "nothing to change sends nothing");
});

test("maintenance statements compare against the time passed in, never GETDATE()", async () => {
    const deleted = [{ ArtefactFk: 2, HospitalId: 7 }, { ArtefactFk: 2, HospitalId: 7 }, { ArtefactFk: 2, HospitalId: 7 }];
    const { repository, sent } = repositoryWith(({ sql }) => {
        if (sql.startsWith("DELETE")) return deleted.splice(0, 1);
        if (sql.startsWith("SELECT Id, ConsentArtefactId")) return [{ Id: 2, ConsentArtefactId: "art-2" }];
        return [];
    });
    const now = new Date("2026-10-26T10:00:00.000Z");
    assert.deepEqual(await repository.purgeRecords(now), [{ artefactFk: 2, hospitalId: 7, consentArtefactId: "art-2", count: 3 }]);
    const purgeStatements = sent.length;
    await repository.clearPrivateKeys(now);
    await repository.listTimedOutTransfers(now, 50);
    await repository.closeStaleClaimed(now);
    for (const { sql, parameters } of sent.filter((item) => !item.sql.startsWith("SELECT Id, ConsentArtefactId"))) {
        assert.ok(!/GETDATE/i.test(sql));
        assert.equal(((parameters[0] as MssqlParameter).value as Date).getTime(), now.getTime());
    }
    assert.match(sent[0].sql, /^DELETE TOP \(1\) rec\s+OUTPUT deleted\.ArtefactFk, deleted\.HospitalId\s+FROM AbdmHiuRecords rec/);
    assert.match(sent[0].sql, /rec\.DeleteAt <= @0 OR a\.DataEraseAt <= @0 OR a\.Status <> 'GRANTED'/);
    assert.equal(sent.filter((item) => item.sql.startsWith("DELETE")).length, 4, "one row per statement, until none is due");
    assert.deepEqual(sent.find((item) => item.sql.startsWith("SELECT Id, ConsentArtefactId"))!.parameters, [2], "only real artefact ids are bound");
    assert.match(sent[purgeStatements].sql, /KeyExpiresAt <= @0 OR SessionStatus IN \('RECEIVED', 'FAILED'\)/);
});

test("a sweep with nothing due sends one delete and the stamp, and reports nothing", async () => {
    const { repository, sent } = repositoryWith(() => []);
    assert.deepEqual(await repository.purgeRecords(new Date("2026-10-26T10:00:00.000Z")), []);
    assert.deepEqual(sent.map((item) => item.sql.slice(0, 6)), ["DELETE", "UPDATE"]);
});

test("the sweep stamps every artefact left with no records once ended or past its erase date, and stops deleting at its time budget", async () => {
    let clock = 0;
    const { repository, sent } = repositoryWith(({ sql }) => {
        if (sql.startsWith("DELETE")) {
            clock += 15_000;
            return [{ ArtefactFk: clock / 15_000, HospitalId: 7 }];
        }
        if (sql.startsWith("SELECT Id, ConsentArtefactId")) return [{ Id: 1, ConsentArtefactId: "art-1" }, { Id: 2, ConsentArtefactId: null }];
        return [];
    }, { clock: () => clock });
    const now = new Date("2026-10-26T10:00:00.000Z");
    const purged = await repository.purgeRecords(now);
    assert.equal(sent.filter((item) => item.sql.startsWith("DELETE")).length, Math.ceil(PURGE_SWEEP_BUDGET_MS / 15_000), "stopped at the budget; the rest wait");
    assert.deepEqual(purged.map((item) => [item.artefactFk, item.consentArtefactId, item.count]), [[1, "art-1", 1], [2, null, 1], [3, null, 1]]);
    const stamps = sent.filter((item) => item.sql.startsWith("UPDATE a SET RecordsPurgedAt"));
    assert.equal(stamps.length, 1);
    assert.match(stamps[0].sql, /WHERE a\.RecordsPurgedAt IS NULL AND \(a\.Status <> 'GRANTED' OR a\.DataEraseAt <= @0\)\s+AND NOT EXISTS \(SELECT 1 FROM AbdmHiuRecords r WHERE r\.ArtefactFk = a\.Id\)/);
});

test("a sweep delete that still fails stops the sweep's deleting, but what it deleted is still stamped and reported", async () => {
    let calls = 0;
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    try {
        const { repository, sent } = repositoryWith(({ sql }) => {
            if (sql.startsWith("DELETE")) {
                calls += 1;
                if (calls <= 2) return [{ ArtefactFk: 4, HospitalId: 7 }];
                throw Object.assign(new Error("The request limit for the database is 30 and has been reached."), { code: "EREQUEST", number: 245 });
            }
            if (sql.startsWith("SELECT Id, ConsentArtefactId")) return [{ Id: 4, ConsentArtefactId: "art-4" }];
            return [];
        });
        const purged = await repository.purgeRecords(new Date("2026-10-26T10:00:00.000Z"));
        assert.deepEqual(purged, [{ artefactFk: 4, hospitalId: 7, consentArtefactId: "art-4", count: 2 }]);
        assert.ok(sent.some((item) => item.sql.startsWith("UPDATE a SET RecordsPurgedAt")), "still stamped");
        assert.deepEqual(errors, ["[ABDM HIU] maintenance: a record delete failed (245); the next sweep goes on"]);
    } finally {
        console.error = originalError;
    }
});
