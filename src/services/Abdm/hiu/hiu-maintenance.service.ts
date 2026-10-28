import { HIU_AUDIT_EVENTS, HIU_AUDIT_OUTCOMES, type HiuAudit } from "./hiu-audit.js";
import type { HiuConsentService } from "./hiu-consent.service.js";
import type { HiuDataFlowService } from "./hiu-data-flow.service.js";

/**
 * The HIU's housekeeping sweep (plan sections 5, 10 and 13 S7), run once a minute:
 *
 *   1. Delete stored records past their DeleteAt (the artefact's dataEraseAt), and every record of
 *      an artefact that is no longer GRANTED (revoked or lapsed, or whose own purge stopped part
 *      way), one row at a time within a time budget, and stamp RecordsPurgedAt once none is left.
 *   2. Set our ephemeral private key to NULL once it passes KeyExpiresAt or its transfer ended.
 *   3. Fail transfers past their window with one health-information/notify FAILED.
 *   4. Close transfers whose notify was claimed but never settled (a crash in between).
 *   5. Fail consent requests whose on-init never came (still SENDING after 15 minutes).
 *   6. Fetch again granted artefacts whose details never came (a refused or unanswered
 *      consent/fetch: the notify is already acknowledged, so ABDM will not repeat it).
 *
 * Safe with several instances: every step is one atomic statement, and a timed-out transfer is
 * notified only by the instance whose claim on NotifiedAt succeeds (HiuDataFlowService).
 * Logs carry counts only.
 */

export interface HiuMaintenanceStore {
    /**
     * Deletes due records, one row per statement for a bounded time (the rest wait for the next
     * sweep), and stamps their artefacts once none is left. One entry per artefact that lost records.
     */
    purgeRecords(now: Date): Promise<{ artefactFk: number; hospitalId: number; consentArtefactId: string | null; count: number }[]>;
    /** NULLs every private key past KeyExpiresAt or on a RECEIVED/FAILED transfer. Returns how many. */
    clearPrivateKeys(now: Date): Promise<number>;
    /** Open transfers past TransferDeadline whose notify is unclaimed. */
    listTimedOutTransfers(now: Date, limit: number): Promise<number[]>;
    /** Marks FAILED the open transfers whose notify was claimed but which never settled, past their deadline. */
    closeStaleClaimed(now: Date): Promise<number>;
}

export interface HiuMaintenanceDeps {
    store: HiuMaintenanceStore;
    dataFlow: Pick<HiuDataFlowService, "failTransfer">;
    /** The consent side's sweep steps; left out, those steps are skipped. */
    consent?: Pick<HiuConsentService, "failStaleSending" | "retryFetches">;
    audit: HiuAudit;
    clock?: () => number;
}

/** Timed-out transfers handled per sweep; the rest wait for the next one. */
const TIMEOUT_BATCH = 50;

export class HiuMaintenanceService {
    private readonly store: HiuMaintenanceStore;
    private readonly dataFlow: Pick<HiuDataFlowService, "failTransfer">;
    private readonly consent: Pick<HiuConsentService, "failStaleSending" | "retryFetches"> | null;
    private readonly audit: HiuAudit;
    private readonly clock: () => number;
    private running: Promise<void> | null = null;

    constructor(deps: HiuMaintenanceDeps) {
        this.store = deps.store;
        this.dataFlow = deps.dataFlow;
        this.consent = deps.consent ?? null;
        this.audit = deps.audit;
        this.clock = deps.clock ?? Date.now;
    }

    /** One sweep. A failing step is logged and the others still run; it never throws. */
    async runOnce(now: Date = new Date(this.clock())): Promise<void> {
        await this.step("purge records", async () => {
            const purged = await this.store.purgeRecords(now);
            for (const item of purged) {
                await this.audit.record({
                    hospitalId: item.hospitalId,
                    event: HIU_AUDIT_EVENTS.RECORD_PURGED,
                    artefactId: item.consentArtefactId,
                    outcome: HIU_AUDIT_OUTCOMES.OK,
                    detail: `${item.count} records`,
                });
            }
            const total = purged.reduce((sum, item) => sum + item.count, 0);
            if (total) console.log(`[ABDM HIU] maintenance: ${total} records deleted from ${purged.length} artefacts`);
        });

        await this.step("timed-out transfers", async () => {
            const ids = await this.store.listTimedOutTransfers(now, TIMEOUT_BATCH);
            for (const id of ids) {
                await this.dataFlow.failTransfer(id);
            }
            if (ids.length) console.log(`[ABDM HIU] maintenance: ${ids.length} transfers past their window closed`);
        });

        await this.step("stale transfers", async () => {
            const closed = await this.store.closeStaleClaimed(now);
            if (closed) console.log(`[ABDM HIU] maintenance: ${closed} unsettled transfers marked failed`);
        });

        await this.step("private keys", async () => {
            const cleared = await this.store.clearPrivateKeys(now);
            if (cleared) console.log(`[ABDM HIU] maintenance: ${cleared} private keys deleted`);
        });

        const consent = this.consent;
        if (!consent) return;
        await this.step("stale consent requests", async () => {
            const failed = await consent.failStaleSending(now.getTime());
            if (failed) console.log(`[ABDM HIU] maintenance: ${failed} consent requests with no on-init marked failed`);
        });

        await this.step("artefact fetches", async () => {
            const sent = await consent.retryFetches(now.getTime());
            if (sent) console.log(`[ABDM HIU] maintenance: ${sent} consent artefacts fetched again`);
        });
    }

    /**
     * Runs runOnce every [intervalMs] on a timer that never holds the process open. A sweep still
     * running when the next is due is not overlapped. Returns a function that stops it.
     */
    start(intervalMs: number = 60_000): () => void {
        const tick = () => {
            if (this.running) return;
            this.running = this.runOnce().finally(() => {
                this.running = null;
            });
        };
        const timer = setInterval(tick, Math.max(1_000, intervalMs));
        timer.unref();
        return () => clearInterval(timer);
    }

    private async step(name: string, work: () => Promise<void>): Promise<void> {
        try {
            await work();
        } catch (error: any) {
            console.error(`[ABDM HIU] maintenance step "${name}" failed: ${error?.code ?? error?.name ?? "error"}`);
        }
    }
}
