import { HiuAuditEvent } from "../../models/Abdm/hiu-audit-event.model.js";
import type { HiuAudit, HiuAuditEventInput } from "../../services/Abdm/hiu/hiu-audit.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cuts a value to its column's width; empty becomes null. */
const fit = (value: string | null | undefined, length: number): string | null => {
    if (value === undefined || value === null) return null;
    const text = String(value);
    return text.length > 0 ? text.slice(0, length) : null;
};

/** Maps an event to its row, cutting every value to its column so an insert never fails on width. */
export const toAuditRow = (event: HiuAuditEventInput, at: Date): Partial<HiuAuditEvent> => ({
    At: at,
    HospitalId: Number.isInteger(event.hospitalId) ? event.hospitalId : null,
    StaffUserId: event.staffUserId && GUID.test(event.staffUserId) ? event.staffUserId : null,
    Event: fit(event.event, 50) ?? "UNKNOWN",
    ConsentRequestId: fit(event.consentRequestId, 64),
    ArtefactId: fit(event.artefactId, 64),
    TransactionId: fit(event.transactionId, 64),
    RequestId: fit(event.requestId, 64),
    Outcome: fit(event.outcome, 50) ?? "UNKNOWN",
    Detail: fit(event.detail, 500),
});

/** Writes HIU audit events to AbdmHiuAuditEvents. Never throws: a failed write is logged in one line, without the event's detail. */
export class HiuAuditRepository implements HiuAudit {
    private readonly insert: (row: Partial<HiuAuditEvent>) => Promise<unknown>;
    private readonly clock: () => Date;

    constructor(options: { insert?: (row: Partial<HiuAuditEvent>) => Promise<unknown>; clock?: () => Date } = {}) {
        // The data source is loaded on first write, so importing this module (in a test) opens no database config.
        this.insert = options.insert ?? (async (row) => {
            const { AppDataSource } = await import("../../config/database.js");
            return AppDataSource.getRepository(HiuAuditEvent).insert(row);
        });
        this.clock = options.clock ?? (() => new Date());
    }

    async record(event: HiuAuditEventInput): Promise<void> {
        try {
            await this.insert(toAuditRow(event, this.clock()));
        } catch (error: any) {
            console.error(`[ABDM HIU] audit write failed for ${String(event?.event ?? "?").slice(0, 50)}: ${error?.code ?? error?.name ?? "error"}`);
        }
    }
}

export const hiuAuditRepository = new HiuAuditRepository();
