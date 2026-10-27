import type { AbdmFacilityDirectory } from "../abdm-facilities.service.js";
import { LinkingError, type HipLinkingService } from "./hip-linking.js";

/**
 * Links records to the patient's ABHA as they are saved, at hospitals whose facility has AutoLink
 * on. A saved row only says whose it is and where as far as its own columns go: a prescription
 * line names its prescription, a visit record its appointment. Saves come in bursts (a visit saves
 * its prescription, notes and vitals together), so they wait a few seconds to settle, then each
 * patient is linked once: new care contexts with link/carecontext, care contexts already linked
 * that gained records with link/context/notify. A patient with a mobile and no ABHA on record is
 * texted ABDM's deep link instead (sms/notify2), once per new record. The scheduled sweep remains the
 * safety net for linking.
 */

/** What a saved row says about its owner. */
export interface RecordRef {
    patientId?: string | null;
    hospitalId?: number | null;
    appointmentId?: number | null;
    prescriptionId?: string | null;
    /**
     * An update that named no owner (a partial update by id, such as a bill marked Paid): the rows of
     * this table updated since [since] are looked up instead.
     */
    recentIn?: string | null;
    since?: Date | null;
}

export interface RecordOwners {
    /** The patients and hospitals saved rows belong to, read once their transaction has committed. */
    owners(ref: RecordRef): Promise<Array<{ patientId: string; hospitalId: number }>>;
}

type Linking = Pick<HipLinkingService, "link" | "notifyChanges" | "notifyBySms">;
type Facilities = Pick<AbdmFacilityDirectory, "hips">;

const SETTLE_MS = 5_000;

export class AutoLinker {
    private readonly pending = new Map<string, RecordRef>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running: Promise<void> = Promise.resolve();

    constructor(
        private readonly owners: RecordOwners,
        private readonly facilities: Facilities,
        private readonly linking: Linking,
        private readonly settleMs = SETTLE_MS,
    ) {}

    /** A record was saved. Returns at once and never throws: it runs inside the caller's save. */
    recordSaved(ref: RecordRef): void {
        const key = ref.recentIn
            ? `recent|${ref.recentIn}`
            : JSON.stringify([ref.patientId?.toLowerCase() ?? null, ref.hospitalId ?? null, ref.appointmentId ?? null, ref.prescriptionId ?? null]);
        // Several unnamed updates to one table: one look-up, from the earliest
        const earlier = this.pending.get(key)?.since;
        this.pending.set(key, earlier && ref.since && earlier < ref.since ? { ...ref, since: earlier } : ref);
        this.timer ??= setTimeout(() => this.start(), this.settleMs);
    }

    /** Runs what is waiting now, and resolves when every run so far has finished. */
    async settle(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.start();
        }
        await this.running;
    }

    private start() {
        this.timer = null;
        this.running = this.running.then(() => this.flush()).catch((error) => console.error("[ABDM] auto-link failed:", error?.message));
    }

    private async flush() {
        const refs = [...this.pending.values()];
        this.pending.clear();
        const hips = await this.facilities.hips({ autoLink: true });
        if (!hips.length) return;

        const due = new Map<string, { hip: (typeof hips)[number]; patientId: string }>();
        for (const ref of refs) {
            for (const owner of await this.owners.owners(ref).catch(() => [])) {
                const hip = hips.find((h) => h.hospitalId === owner.hospitalId);
                if (hip) due.set(`${hip.id}|${owner.patientId.toLowerCase()}`, { hip, patientId: owner.patientId });
            }
        }

        for (const { hip, patientId } of due.values()) {
            try {
                const linked = await this.linking.link(hip, patientId);
                const notified = await this.linking.notifyChanges(hip, patientId);
                if (linked.queued || notified) {
                    console.log(`[ABDM] auto-link at ${hip.id}: ${linked.queued} care contexts ${linked.status}, ${notified} announced`);
                }
            } catch (error: any) {
                // No ABHA yet, or no gender and date of birth: nothing to link, and the screen says why.
                if (!(error instanceof LinkingError)) {
                    console.warn(`[ABDM] auto-link at ${hip.id} skipped a patient: ${error?.message}`);
                    continue;
                }
                // With no ABHA on record, ABDM texts the patient a link to find the new records instead
                try {
                    const requestId = await this.linking.notifyBySms(hip, patientId);
                    if (requestId) console.log(`[ABDM] auto-link at ${hip.id}: deep-link SMS requested for a patient without ABHA, REQUEST-ID=${requestId}`);
                } catch (smsError: any) {
                    console.warn(`[ABDM] auto-link at ${hip.id}: the deep-link SMS failed: ${smsError?.message}`);
                }
            }
        }
    }
}
