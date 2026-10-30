import { APILogRepository } from "../../repositories/Logs/apilog.repository.js";

const RETENTION_MONTHS = 3;
// Log rows average ~11 KB, so small batches keep each delete inside the 30s request timeout
const BATCH_SIZE = 500;
const BATCH_PAUSE_MS = 500;

export class APILogRetentionService {
    private apiLogRepository = new APILogRepository();
    private schedulerTimeout: NodeJS.Timeout | null = null;
    private isPurging = false;

    /**
     * Deletes API logs older than RETENTION_MONTHS, one batch at a time.
     * A failed run stops where it is and the next run picks up the remaining logs.
     */
    async purgeOldLogs(): Promise<number> {
        if (this.isPurging) return 0;
        this.isPurging = true;

        let totalDeleted = 0;
        try {
            let deleted = 0;
            do {
                deleted = await this.apiLogRepository.deleteLogsOlderThan(RETENTION_MONTHS, BATCH_SIZE);
                totalDeleted += deleted;
                if (deleted === BATCH_SIZE) {
                    await new Promise(resolve => setTimeout(resolve, BATCH_PAUSE_MS));
                }
            } while (deleted === BATCH_SIZE);

            console.log(`[APILogRetention] Deleted ${totalDeleted} log(s) older than ${RETENTION_MONTHS} months`);
        } catch (err: any) {
            console.error(`[APILogRetention] Purge stopped after ${totalDeleted} log(s):`, err.message || err);
        } finally {
            this.isPurging = false;
        }

        return totalDeleted;
    }

    /**
     * Schedules the next purge for midnight IST (process.env.TZ is set in index.ts),
     * then schedules the following night once that purge has finished
     */
    startScheduler() {
        if (this.schedulerTimeout) {
            clearTimeout(this.schedulerTimeout);
        }

        const nextMidnight = new Date();
        nextMidnight.setHours(24, 0, 0, 0);

        console.log(`[APILogRetention] Next purge at ${nextMidnight.toLocaleString("en-IN")} (keeps ${RETENTION_MONTHS} months)`);

        this.schedulerTimeout = setTimeout(async () => {
            await this.purgeOldLogs();
            this.startScheduler();
        }, nextMidnight.getTime() - Date.now());
    }
}

export const apiLogRetentionService = new APILogRetentionService();
