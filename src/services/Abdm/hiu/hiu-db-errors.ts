/**
 * SQL Server errors as the HIU's stores meet them through TypeORM's mssql driver (QueryFailedError
 * carries mssql's RequestError fields: code, and number for a server error), and the retry rule the
 * large writes and the end of an artefact share.
 *
 * Only codes and numbers ever reach logs and audit details, never an error's message.
 */

/** SQL Server's error number, wherever the driver put it; NaN when there is none. */
export const sqlErrorNumber = (error: any): number =>
    Number(error?.number ?? error?.driverError?.number ?? error?.originalError?.info?.number ?? error?.driverError?.originalError?.info?.number);

/** The driver's code: ETIMEOUT, ESOCKET, EREQUEST (any server error) and so on; empty when there is none. */
export const driverCode = (error: any): string => String(error?.code ?? error?.driverError?.code ?? error?.originalError?.code ?? "");

/**
 * Errors after which nothing of the statement was kept, so it is tried again: it ran past
 * requestTimeout (an autocommit statement, or a batch under XACT_ABORT, is rolled back whole) or lost
 * its connection; a deadlock victim (1205); a lock timeout (1222); Azure SQL busy, throttled or
 * failing over (10928, 10929, 40197, 40501, 40613, 49918 to 49920).
 */
const TRANSIENT_SQL_ERRORS = new Set([1205, 1222, 10928, 10929, 40197, 40501, 40613, 49918, 49919, 49920]);
const TRANSIENT_DRIVER_CODES = new Set(["ETIMEOUT", "ESOCKET", "ECONNRESET", "ECONNCLOSED", "ECLOSE", "EPIPE", "ETIMEDOUT"]);

export const isTransientSqlError = (error: any): boolean =>
    TRANSIENT_DRIVER_CODES.has(driverCode(error)) || TRANSIENT_SQL_ERRORS.has(sqlErrorNumber(error));

/** An error as a log line or audit detail may show it: SQL Server's number, else the driver's code, else its kind or name. */
export const errorCodeOf = (error: any): string => {
    const number = sqlErrorNumber(error);
    if (Number.isFinite(number)) return String(number);
    return String(driverCode(error) || error?.kind || error?.name || "error").slice(0, 40);
};

/** Waits before each further try of a transient failure; one more try than there are waits. */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000];

/**
 * A statement that ran its whole requestTimeout is tried once more only: one that cannot finish in
 * time (a page too large for the database's log rate) will not the next time either, and every
 * further try holds up the writes queued behind it.
 */
const MAX_TIMEOUT_RETRIES = 1;

export interface RetryOptions {
    /** Names the work in the log line ("record delete"); no ids, no content. */
    label: string;
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    /** A number in [0, 1) that spreads each wait over 75% to 125% of its delay; Math.random unless a test fixes it. */
    random?: () => number;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs [work], given its try number from 1, and tries again after a transient error, which kept
 * nothing. Any other error, or the last try's, is thrown.
 */
export const retryTransient = async <T>(work: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> => {
    const delays = options.delaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
    const sleep = options.sleep ?? wait;
    // Spread, so writers that timed out together (on several instances) do not all try again together.
    const random = options.random ?? Math.random;
    let timeouts = 0;
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await work(attempt);
        } catch (error) {
            const delay = delays[attempt - 1];
            if (delay === undefined || !isTransientSqlError(error)) throw error;
            if (driverCode(error) === "ETIMEOUT" && ++timeouts > MAX_TIMEOUT_RETRIES) throw error;
            console.warn(`[ABDM HIU] ${options.label}: ${errorCodeOf(error)}, trying again (${attempt + 1} of ${delays.length + 1})`);
            await sleep(Math.round(delay * (0.75 + 0.5 * random())));
        }
    }
};

/** A purge that stopped part way: how many rows it had deleted, and what stopped it. */
export class RecordPurgeError extends Error {
    constructor(readonly deleted: number, readonly failure: unknown) {
        super(`Records purge stopped after ${deleted} rows: ${errorCodeOf(failure)}`);
        this.name = "RecordPurgeError";
    }
}
