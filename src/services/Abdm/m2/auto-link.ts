import type { AbdmFacilityDirectory } from "../abdm-facilities.service.js";
import { LinkingError, type HipLinkingService } from "./hip-linking.js";

/**
 * Links records to the patient's ABHA as they are saved, at hospitals whose facility has AutoLink
 * on. A saved row only says whose it is and where as far as its own columns go: a prescription
 * line names its prescription, a visit record its appointment. Saves come in bursts (a visit saves
 * its prescription, notes and vitals together), so they wait a few seconds to settle, then each
 * patient is linked once: new care contexts with link/carecontext, care contexts already linked
 * that gained records with link/context/notify. The scheduled sweep remains the safety net.
 */

/** What a saved row says about its owner. */
export interface RecordRef {
    patientId?: string | null;
    hospitalId?: number | null;
    appointmentId?: number | null;
    prescriptionId?: string | null;
}

export interface RecordOwners {
    /** The patient and hospital a saved row belongs to, read once its transaction has committed. */
    owner(ref: RecordRef): Promise<{ patientId: string; hospitalId: number } | null>;
}

type Linking = Pick<HipLinkingService, "link" | "notifyChanges">;
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
        const key = JSON.stringify([ref.patientId?.toLowerCase() ?? null, ref.hospitalId ?? null, ref.appointmentId ?? null, ref.prescriptionId ?? null]);
        this.pending.set(key, ref);
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
            const owner = await this.owners.owner(ref).catch(() => null);
            const hip = owner && hips.find((h) => h.hospitalId === owner.hospitalId);
            if (hip) due.set(`${hip.id}|${owner.patientId.toLowerCase()}`, { hip, patientId: owner.patientId });
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
                if (!(error instanceof LinkingError)) console.warn(`[ABDM] auto-link at ${hip.id} skipped a patient: ${error?.message}`);
            }
        }
    }
}
