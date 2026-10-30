import { LARGE_WRITE_LOCK, LARGE_WRITE_LOCK_POLL_MS, LargeWriteLockError } from "../../repositories/Abdm/hiu-data.repository.js";

/**
 * AbdmHiuRecords.Content from NVARCHAR(MAX) to VARCHAR(MAX) (up), and back (down). Content only ever
 * holds a sealed value (hiu-at-rest seal(): "hiu1:<keyId>:" and base64, all ASCII), so VARCHAR keeps
 * the same characters at one byte each instead of two: half the stored bytes, and half the log every
 * page insert writes. What is stored does not change, only how it is encoded.
 *
 * Not one ALTER COLUMN: a type change rewrites every value in one transaction, under a schema lock that
 * holds every read and page insert until it is done. On a small Azure SQL tier (S0, 10 DTU) the log rate
 * makes that minutes for a big table, and a page pushed meanwhile times out and is lost. Instead:
 *
 *   1. ContentNew is added in the new type (metadata only, instant);
 *   2. it is filled in Id order, about BATCH_CHARS characters per transaction, each under the
 *      large-write lock (LARGE_WRITE_LOCK), so a batch never competes with a page insert or a record
 *      delete for the log; a run stopped between batches has lost nothing;
 *   3. in one short transaction, with the table locked, the rows that came in meanwhile are copied,
 *      Content is dropped and ContentNew renamed to Content. While any row's content would not
 *      survive the new type (a character outside printable ASCII, for VARCHAR) nothing is swapped;
 *   4. reclaimDroppedContent() gives back the dropped column's pages (DBCC CLEANTABLE, in batches).
 *
 * Every step reads the table's state first, so a run that stopped resumes where it was, and a run in
 * either direction abandons an unfinished one in the other.
 */

/** Content's type: what up converts to, and what down converts back to. */
export type HiuContentType = "varchar" | "nvarchar";

export type ContentMigrationQuery = (statement: string) => Promise<any>;

const TABLE = "dbo.AbdmHiuRecords";
/** The column a conversion fills before it takes Content's place. */
export const PENDING_COLUMN = "ContentNew";

/** Characters one batch copies, at least one row: a few MB, seconds of log even on S0. */
export const BATCH_CHARS = 2 * 1024 * 1024;
/** Rows one batch looks at, so a run of small or empty rows is not read in one go. */
export const BATCH_ROWS = 500;
/** How long one step waits for the large-write lock in all (an admin run can outwait a page insert). */
export const LOCK_WAIT_MS = 10 * 60_000;
/** Rows per DBCC CLEANTABLE transaction. */
export const RECLAIM_BATCH_ROWS = 100;

export interface ContentMigrationOptions {
    batchChars?: number;
    lockWaitMs?: number;
    clock?: () => number;
    log?: (line: string) => void;
}

export interface ContentState {
    /** Content's type; null when AbdmHiuRecords or its Content column does not exist. */
    contentType: string | null;
    /** ContentNew's type while a conversion is unfinished, else null. */
    pendingType: string | null;
}

export interface ContentConversion {
    /** Content was swapped for a column of the new type in this run. */
    converted: boolean;
    /** Rows whose content this run copied (batches and catch-up). */
    copied: number;
    /** An unfinished conversion's column this run dropped (the other way, or one refused). */
    abandoned: string | null;
}

export interface HiuRecordsSize {
    contentType: string | null;
    pendingType: string | null;
    records: number;
    withContent: number;
    contentBytes: number;
    /** Rows whose content the unfinished conversion has copied. */
    pendingCopied: number | null;
    /** Pages reserved for the table and its indexes, in bytes; null without VIEW DATABASE STATE. */
    reservedBytes: number | null;
}

/** The predicate a row's content must meet to be copied into [to]: VARCHAR only takes printable ASCII. */
const survives = (to: HiuContentType, column: string): string =>
    to === "varchar" ? `${column} COLLATE Latin1_General_100_BIN2 NOT LIKE N'%[^ -~]%'` : "1 = 1";

const declared = (to: HiuContentType): string => (to === "varchar" ? "VARCHAR(MAX)" : "NVARCHAR(MAX)");

/**
 * Opens a transaction holding LARGE_WRITE_LOCK, or answers LockResult (sp_getapplock's result) and
 * stops: the statement after it runs only once the lock is held, and COMMIT gives the lock back.
 */
const lockedTransaction = (refused: string): string => `SET XACT_ABORT ON;
SET NOCOUNT ON;
BEGIN TRANSACTION;
DECLARE @lock INT;
EXEC @lock = sp_getapplock @Resource = '${LARGE_WRITE_LOCK}', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = ${LARGE_WRITE_LOCK_POLL_MS};
IF @lock < 0
BEGIN
    ROLLBACK TRANSACTION;
    SELECT @lock AS LockResult, ${refused};
    RETURN;
END;`;

const stateStatement = `SELECT
    (SELECT TYPE_NAME(c.user_type_id) FROM sys.columns c WHERE c.object_id = OBJECT_ID(N'${TABLE}', N'U') AND c.name = 'Content') AS ContentType,
    (SELECT TYPE_NAME(c.user_type_id) FROM sys.columns c WHERE c.object_id = OBJECT_ID(N'${TABLE}', N'U') AND c.name = '${PENDING_COLUMN}') AS PendingType;`;

/**
 * Copies the rows after Id [afterId] still to be copied, up to [budgetBytes] of their content (at
 * least one row); rows copied before (a resumed run) count for nothing, so they are passed quickly.
 */
export const copyBatchStatement = (to: HiuContentType, afterId: number, budgetBytes: number): string => `${lockedTransaction("0 AS Copied, 0 AS Skipped, CAST(NULL AS INT) AS LastId")}
DECLARE @batch TABLE (Id INT PRIMARY KEY);
INSERT INTO @batch (Id)
SELECT Id FROM (
    SELECT TOP (${BATCH_ROWS}) Id,
           ROW_NUMBER() OVER (ORDER BY Id) AS Position,
           SUM(CASE WHEN ${PENDING_COLUMN} IS NULL THEN CAST(ISNULL(DATALENGTH(Content), 0) AS BIGINT) ELSE 0 END)
               OVER (ORDER BY Id ROWS UNBOUNDED PRECEDING) AS Running
    FROM ${TABLE}
    WHERE Id > ${afterId}
    ORDER BY Id
) next
WHERE Position = 1 OR Running <= ${budgetBytes};
UPDATE r SET ${PENDING_COLUMN} = CAST(r.Content AS ${declared(to)})
FROM ${TABLE} r INNER JOIN @batch b ON b.Id = r.Id
WHERE r.Content IS NOT NULL AND r.${PENDING_COLUMN} IS NULL AND ${survives(to, "r.Content")};
DECLARE @copied INT = @@ROWCOUNT;
SELECT 0 AS LockResult, @copied AS Copied,
       (SELECT COUNT(*) FROM ${TABLE} r INNER JOIN @batch b ON b.Id = r.Id WHERE r.Content IS NOT NULL AND r.${PENDING_COLUMN} IS NULL) AS Skipped,
       (SELECT MAX(Id) FROM @batch) AS LastId;
COMMIT TRANSACTION;`;

/**
 * Copies what came in since the batches, with the table locked (TABLOCKX) until COMMIT, then, unless
 * a row is still uncopied (Remaining), drops Content and renames ContentNew to Content.
 */
export const swapStatement = (to: HiuContentType): string => `${lockedTransaction("0 AS CaughtUp, 0 AS Remaining")}
UPDATE r SET ${PENDING_COLUMN} = CAST(r.Content AS ${declared(to)})
FROM ${TABLE} r WITH (TABLOCKX, HOLDLOCK)
WHERE r.Content IS NOT NULL AND r.${PENDING_COLUMN} IS NULL AND ${survives(to, "r.Content")};
DECLARE @caughtUp INT = @@ROWCOUNT;
DECLARE @remaining INT = (SELECT COUNT(*) FROM ${TABLE} WITH (TABLOCKX, HOLDLOCK) WHERE Content IS NOT NULL AND ${PENDING_COLUMN} IS NULL);
IF @remaining > 0
BEGIN
    ROLLBACK TRANSACTION;
    SELECT 0 AS LockResult, @caughtUp AS CaughtUp, @remaining AS Remaining;
    RETURN;
END;
ALTER TABLE ${TABLE} DROP COLUMN Content;
EXEC sp_rename N'${TABLE}.${PENDING_COLUMN}', N'Content', N'COLUMN';
COMMIT TRANSACTION;
SELECT 0 AS LockResult, @caughtUp AS CaughtUp, 0 AS Remaining;`;

const dropPendingStatement = `IF COL_LENGTH('${TABLE}', '${PENDING_COLUMN}') IS NOT NULL ALTER TABLE ${TABLE} DROP COLUMN ${PENDING_COLUMN};`;

const firstRow = (result: any): any => (Array.isArray(result) ? result[0] : undefined) ?? {};

export async function readContentState(run: ContentMigrationQuery): Promise<ContentState> {
    const row = firstRow(await run(stateStatement));
    return { contentType: row.ContentType ?? null, pendingType: row.PendingType ?? null };
}

/**
 * Converts AbdmHiuRecords.Content to [to] (see the module's comment), or does nothing when it is
 * [to] already. Throws, with the table as it was before this run's swap, when a row's content would
 * not survive [to]; the half-filled column is dropped first.
 */
export async function convertHiuRecordContent(run: ContentMigrationQuery, to: HiuContentType, options: ContentMigrationOptions = {}): Promise<ContentConversion> {
    const log = options.log ?? ((line: string) => console.log(line));
    const clock = options.clock ?? Date.now;
    const lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
    // DATALENGTH is the source column's: two bytes a character in NVARCHAR.
    const budgetBytes = (options.batchChars ?? BATCH_CHARS) * (to === "varchar" ? 2 : 1);

    /** Runs [statement] until it gets the lock, asking every LARGE_WRITE_LOCK_POLL_MS for at most lockWaitMs. */
    const underLock = async (statement: string): Promise<any> => {
        const started = clock();
        for (;;) {
            const row = firstRow(await run(statement));
            const result = Number(row.LockResult);
            if (result >= 0) return row;
            if (result !== -1 || clock() - started >= lockWaitMs) throw new LargeWriteLockError(result);
        }
    };

    const state = await readContentState(run);
    if (!state.contentType) throw new Error(`${TABLE}.Content does not exist; nothing to convert.`);
    let abandoned: string | null = null;
    if (state.pendingType && (state.contentType === to || state.pendingType !== to)) {
        await run(dropPendingStatement);
        abandoned = state.pendingType;
        log(`Dropped ${PENDING_COLUMN} (${state.pendingType}), left by an unfinished conversion.`);
    }
    if (state.contentType === to) return { converted: false, copied: 0, abandoned };
    if (state.pendingType !== to || abandoned) {
        await run(`ALTER TABLE ${TABLE} ADD ${PENDING_COLUMN} ${declared(to)} NULL;`);
    } else {
        log(`Resuming the conversion to ${declared(to)}.`);
    }

    /** Leaves the table as this run found it (Content untouched) and says why. */
    const refuse = async (rows: number): Promise<never> => {
        await run(dropPendingStatement);
        throw new Error(`${rows} record(s) hold characters ${declared(to)} would not keep; Content is unchanged.`);
    };

    let afterId = 0;
    let copied = 0;
    let skipped = 0;
    for (let batches = 1; ; batches += 1) {
        const row = await underLock(copyBatchStatement(to, afterId, budgetBytes));
        if (row.LastId === null || row.LastId === undefined) break;
        afterId = Number(row.LastId);
        copied += Number(row.Copied) || 0;
        skipped += Number(row.Skipped) || 0;
        if (batches % 20 === 0) log(`Copied ${copied} record(s), up to Id ${afterId}.`);
    }
    if (skipped > 0) await refuse(skipped);

    const swap = await underLock(swapStatement(to));
    copied += Number(swap.CaughtUp) || 0;
    if (Number(swap.Remaining) > 0) await refuse(Number(swap.Remaining));
    log(`Content is ${declared(to)}: ${copied} record(s) copied.`);
    return { converted: true, copied, abandoned };
}

/**
 * Gives back the pages of the column a conversion dropped: DBCC CLEANTABLE, RECLAIM_BATCH_ROWS rows a
 * transaction. Outside any transaction, and safe to repeat. Until it runs, the table keeps the old
 * column's space (DROP COLUMN only changes metadata).
 */
export async function reclaimDroppedContent(run: ContentMigrationQuery): Promise<void> {
    await run(`DBCC CLEANTABLE (0, N'${TABLE}', ${RECLAIM_BATCH_ROWS}) WITH NO_INFOMSGS;`);
}

/**
 * measureHiuRecords() once the pages reclaimDroppedContent() freed have left the table: SQL Server
 * deallocates them in the background, seconds after DBCC CLEANTABLE returns (about 15 s locally).
 * Asks every [pollMs] until the reserved space has fallen and holds still, for at most [maxWaitMs].
 */
export async function measureSettled(
    run: ContentMigrationQuery,
    options: { pollMs?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<HiuRecordsSize> {
    const pollMs = options.pollMs ?? 5_000;
    const maxWaitMs = options.maxWaitMs ?? 60_000;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let last = await measureHiuRecords(run);
    let fell = false;
    for (let waited = 0; last.reservedBytes !== null && waited < maxWaitMs; waited += pollMs) {
        await sleep(pollMs);
        const next = await measureHiuRecords(run);
        if (next.reservedBytes === null) return next;
        if (next.reservedBytes < last.reservedBytes) fell = true;
        else if (fell) return next;
        last = next;
    }
    return last;
}

/** How many records the table holds, how many bytes of content, and how much space it reserves. */
export async function measureHiuRecords(run: ContentMigrationQuery): Promise<HiuRecordsSize> {
    const state = await readContentState(run);
    const size: HiuRecordsSize = { ...state, records: 0, withContent: 0, contentBytes: 0, pendingCopied: null, reservedBytes: null };
    if (!state.contentType) return size;
    const row = firstRow(await run(`SELECT COUNT_BIG(*) AS Records, COUNT_BIG(Content) AS WithContent,
       ISNULL(SUM(CAST(DATALENGTH(Content) AS BIGINT)), 0) AS ContentBytes${state.pendingType ? `,
       COUNT_BIG(${PENDING_COLUMN}) AS PendingCopied` : ""}
FROM ${TABLE};`));
    size.records = Number(row.Records) || 0;
    size.withContent = Number(row.WithContent) || 0;
    size.contentBytes = Number(row.ContentBytes) || 0;
    if (state.pendingType) size.pendingCopied = Number(row.PendingCopied) || 0;
    try {
        const reserved = firstRow(await run(`SELECT ISNULL(SUM(reserved_page_count), 0) * 8192 AS ReservedBytes
FROM sys.dm_db_partition_stats WHERE object_id = OBJECT_ID(N'${TABLE}', N'U');`));
        size.reservedBytes = Number(reserved.ReservedBytes) || 0;
    } catch {
        // Needs VIEW DATABASE STATE; the content figures stand without it.
    }
    return size;
}
