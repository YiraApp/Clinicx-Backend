import { test } from "node:test";
import assert from "node:assert/strict";
import { MssqlParameter } from "typeorm/index.js";
import { HiuError } from "../../services/Abdm/hiu/hiu-enums.js";
import { HiuDataRepository, isDuplicateKeyError, toDataRequestRow } from "./hiu-data.repository.js";

type Sent = { sql: string; parameters: unknown[] };

/** A repository over a stub query that records each statement and answers with [answer]. */
const repositoryWith = (answer: (sent: Sent) => any) => {
    const sent: Sent[] = [];
    const repository = new HiuDataRepository({
        query: async (sql, parameters = []) => {
            const item = { sql, parameters };
            sent.push(item);
            return answer(item);
        },
    });
    return { repository, sent };
};

const duplicateKey = () => Object.assign(new Error("Violation of UNIQUE KEY constraint"), { driverError: { number: 2627 } });

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
    assert.match(sql, /SET XACT_ABORT ON;\s+BEGIN TRANSACTION;/);
    assert.match(sql, /PagesReceived = PagesReceived \+ 1 OUTPUT inserted\.PagesReceived/);
    assert.match(sql, /INSERT INTO AbdmHiuRecords [^;]+;\s+COMMIT TRANSACTION;/);
    assert.deepEqual(parameters.slice(0, 2), [9, 2]);
    assert.equal(parameters.length, 2 + 2 * 11);
    assert.ok(sql.includes("(@2, @3, @4, @5, @6, @7, @8, @9, @10, @11, @12), (@13,"));
    const boundDeleteAt = parameters[11] as MssqlParameter;
    assert.ok(boundDeleteAt instanceof MssqlParameter);
    assert.equal(boundDeleteAt.type, "datetime2");
    assert.equal((boundDeleteAt.value as Date).getTime(), deleteAt.getTime());
});

test("a page is stored only under a granted, unpurged artefact (locked first) and an open transfer; else it is reported closed", async () => {
    const { repository, sent } = repositoryWith(() => [{ PagesReceived: 1 }]);
    await repository.addPage({ dataRequestId: 9, artefactFk: 2, hospitalId: 7, pageNumber: 1, records: [{ entryIndex: 0, careContextReference: null, media: null, checksumOk: true, content: "c", deleteAt: null }] });
    const { sql } = sent[0];
    const artefactCheck = sql.search(/FROM AbdmHiuConsentArtefacts WITH \(UPDLOCK, HOLDLOCK\)\s+WHERE Id = @1 AND Status = 'GRANTED' AND RecordsPurgedAt IS NULL/);
    const update = sql.indexOf("UPDATE AbdmHiuDataRequests");
    const insert = sql.indexOf("INSERT INTO AbdmHiuRecords");
    assert.ok(artefactCheck > 0 && artefactCheck < update && update < insert, "artefact locked, then the transfer, then the insert");
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
        { duplicate: true, pagesReceived: 0 },
    );
    const failing = repositoryWith(() => { throw Object.assign(new Error("deadlock"), { number: 1205 }); });
    await assert.rejects(failing.repository.addPage({ dataRequestId: 9, artefactFk: 2, hospitalId: 7, pageNumber: 1, records: [] }), /deadlock/);
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
    const { repository, sent } = repositoryWith(() => [{ ArtefactFk: 2, HospitalId: 7, ConsentArtefactId: "art-2", Purged: 3 }]);
    const now = new Date("2026-10-26T10:00:00.000Z");
    assert.deepEqual(await repository.purgeRecords(now), [{ artefactFk: 2, hospitalId: 7, consentArtefactId: "art-2", count: 3 }]);
    await repository.clearPrivateKeys(now);
    await repository.listTimedOutTransfers(now, 50);
    await repository.closeStaleClaimed(now);
    for (const { sql, parameters } of sent) {
        assert.ok(!/GETDATE/i.test(sql));
        assert.equal(((parameters[0] as MssqlParameter).value as Date).getTime(), now.getTime());
    }
    assert.match(sent[0].sql, /rec\.DeleteAt <= @0 OR a\.DataEraseAt <= @0 OR a\.Status <> 'GRANTED'/);
    assert.match(sent[1].sql, /KeyExpiresAt <= @0 OR SessionStatus IN \('RECEIVED', 'FAILED'\)/);
});
