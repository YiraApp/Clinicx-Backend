import { createHash } from "node:crypto";
import { AppDataSource } from "../../../config/database.js";
import { recordPdfOf } from "../fhir/record-pdf.js";
import { abdmHealthRecordService, type HealthRecordBundle } from "../abdm-health-record.service.js";
import { abdmFacilities } from "../abdm-facilities.service.js";
import { blobService } from "../../Common/blob.service.js";
import { abdmRecordOwners } from "../../../repositories/Abdm/abdm-m2.repository.js";
import { abdmRecordPdfRepository, type RecordPdfStore, type StoredPdf } from "../../../repositories/Abdm/abdm-record-pdf.repository.js";
import { bundleIdOf, type RecordLocation } from "../record-pdf-preview.service.js";
import { careContextReference, parseCareContextReference } from "./care-contexts.js";
import { bundlesForReference } from "./data-flow.js";
import type { CareContextKind, Hip } from "./m2-store.js";
import type { RecordOwners, RecordRef } from "./auto-link.js";
import type { RecordSource } from "./record-subscriber.js";

/**
 * Keeps every version of the PDF each shared record carries, in a private blob container, for
 * later. A save is seen like the auto-linker sees it (any screen or API, through TypeORM); after a
 * few seconds' settle, the care contexts the saved rows belong to are built as a consented fetch
 * would build them, and each record's PDF not stored yet (by its SHA-1) is uploaded and recorded
 * in AbdmRecordPdfs. Runs at every ABDM facility, whatever its AutoLink setting, and only in the
 * server that made the save. A failure is logged without patient detail and never touches the save.
 */

export const RECORD_PDF_CONTAINER = (process.env.ABDM_RECORD_PDF_CONTAINER || "abdm-record-pdfs").toLowerCase();

const SETTLE_MS = 5_000;

export interface PdfBlobs {
    upload(path: string, data: Buffer): Promise<string>;
    read(url: string): Promise<Buffer>;
}

/** The stored versions of one record's PDF. */
export interface RecordPdfVersions {
    /** Newest first. */
    versions(hospitalId: number, loc: Pick<RecordLocation, "reference" | "hiType" | "recordKey">): Promise<StoredPdf[]>;
    version(hospitalId: number, loc: Pick<RecordLocation, "reference" | "hiType" | "recordKey">, versionId: string): Promise<Buffer | null>;
}

export interface ArchiveDeps {
    owners: RecordOwners;
    hips: () => Promise<Hip[]>;
    store: RecordPdfStore;
    blobs: PdfBlobs;
    bundles: (reference: string) => Promise<HealthRecordBundle[]>;
    /** The visit a prescription was written at, if any. */
    prescriptionVisit: (prescriptionId: string) => Promise<number | null>;
    /** Every care context the patient has at the facility (the catalog, refreshed). */
    references: (hip: Hip, patientId: string) => Promise<string[]>;
    settleMs?: number;
    now?: () => Date;
}

// Always a care context of their own, even when made at a visit
const OWN_CONTEXT: Record<string, CareContextKind> = { DiagnosticReports: "report", WellnessRecords: "wellness", DischargeSummaries: "discharge" };
// Their own care context when saved outside a visit
const OUTSIDE_VISIT: Record<string, CareContextKind> = { PatientPrescription: "prescription", PatientClinicalNotes: "note", PatientImmunizations: "immunization" };

/**
 * The care contexts a save can have changed: exact references when the row says enough, else the
 * kinds of the patient's care contexts to look through ("all" when it says nothing).
 */
export type SaveTarget = { references: string[] } | { kinds: CareContextKind[] | "all" };

export const targetOfSave = (ref: RecordRef, source: RecordSource | null): SaveTarget => {
    const table = source?.table ?? ref.recentIn ?? null;
    const id = source?.id ?? null;
    if (table && OWN_CONTEXT[table]) return id ? { references: [careContextReference(OWN_CONTEXT[table], id)] } : { kinds: [OWN_CONTEXT[table]] };
    if (ref.appointmentId) return { references: [careContextReference("visit", ref.appointmentId)] };
    if (table === "PatientMedicalRecord") {
        return id && source?.vitals !== undefined
            ? { references: [careContextReference(source.vitals ? "vitals" : "consultation", id)] }
            : { kinds: ["vitals", "consultation"] };
    }
    if (table && OUTSIDE_VISIT[table]) return id ? { references: [careContextReference(OUTSIDE_VISIT[table], id)] } : { kinds: [OUTSIDE_VISIT[table], "visit"] };
    if (table === "AppointmentBills" || table === "PostVisitDocuments") return { kinds: ["visit"] };
    // An upload outside a visit carries no PDF of its own: it is the record
    if (table === "MedicalDocuments") return { references: [] };
    return { kinds: "all" };
};

const sha1Hex = (data: Buffer) => createHash("sha1").update(data).digest("hex");

export class RecordPdfArchive implements RecordPdfVersions {
    private readonly pending = new Map<string, { ref: RecordRef; source: RecordSource | null }>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running: Promise<void> = Promise.resolve();

    constructor(private readonly deps: ArchiveDeps) {}

    /** A record was saved. Returns at once and never throws: it runs inside the caller's save. */
    recordSaved(ref: RecordRef, source: RecordSource | null = null): void {
        try {
            const key = JSON.stringify([
                ref.patientId?.toLowerCase() ?? null, ref.hospitalId ?? null, ref.appointmentId ?? null, ref.prescriptionId ?? null,
                ref.recentIn ?? null, source?.table ?? null, source?.id ?? null,
            ]);
            this.pending.set(key, { ref, source });
            this.timer ??= setTimeout(() => this.start(), this.deps.settleMs ?? SETTLE_MS);
        } catch (error: any) {
            console.warn(`[ABDM] a saved record could not be queued for its PDF: ${error?.message}`);
        }
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
        this.running = this.running.then(() => this.flush()).catch((error) => console.error("[ABDM] storing record PDFs failed:", error?.message));
    }

    private async flush() {
        const saves = [...this.pending.values()];
        this.pending.clear();
        const hips = await this.deps.hips();
        if (!hips.length) return;

        const jobs = new Map<string, { hip: Hip; patientId: string; reference: string }>();
        for (const { ref, source } of saves) {
            for (const owner of await this.deps.owners.owners(ref).catch(() => [])) {
                const hip = hips.find((h) => h.hospitalId === owner.hospitalId);
                if (!hip) continue;
                for (const reference of await this.referencesFor(ref, source, hip, owner.patientId)) {
                    jobs.set(`${hip.id}|${reference}`, { hip, patientId: owner.patientId, reference });
                }
            }
        }
        for (const job of jobs.values()) {
            try {
                await this.store(job);
            } catch (error: any) {
                console.warn(`[ABDM] the PDFs of care context ${job.reference} could not be stored: ${error?.message}`);
            }
        }
    }

    private async referencesFor(ref: RecordRef, source: RecordSource | null, hip: Hip, patientId: string): Promise<string[]> {
        // A prescription line names only its prescription: the visit it was written at, or its own
        if (ref.prescriptionId && !ref.appointmentId) {
            const visit = await this.deps.prescriptionVisit(ref.prescriptionId);
            return [visit ? careContextReference("visit", visit) : careContextReference("prescription", ref.prescriptionId)];
        }
        const target = targetOfSave(ref, source);
        if ("references" in target) return target.references;
        const all = await this.deps.references(hip, patientId);
        if (target.kinds === "all") return all;
        const kinds = target.kinds;
        return all.filter((r) => {
            const parsed = parseCareContextReference(r);
            return parsed !== null && kinds.includes(parsed.kind);
        });
    }

    /** Stores each record's PDF of the care context that isn't stored yet; returns how many were. */
    async store(job: { hip: Hip; patientId: string; reference: string }): Promise<number> {
        let stored = 0;
        for (const b of await this.deps.bundles(job.reference)) {
            const pdf = recordPdfOf(b.bundle);
            if (!pdf) continue;
            const sha1 = sha1Hex(pdf.data);
            if (await this.deps.store.has(job.hip.hospitalId, job.reference, b.key, sha1)) continue;
            // No names in the path: the hospital, the care context, the record and the file's checksum
            const blobUrl = await this.deps.blobs.upload(`${job.hip.hospitalId}/${job.reference}/${b.hiType}/${b.key}/${sha1}.pdf`, pdf.data);
            await this.deps.store.add({
                hospitalId: job.hip.hospitalId,
                patientUserId: job.patientId,
                reference: job.reference,
                hiType: b.hiType,
                recordKey: b.key,
                source: pdf.source,
                sha1,
                bytes: pdf.data.length,
                blobUrl,
                createdAt: (this.deps.now ?? (() => new Date()))(),
            });
            stored++;
        }
        return stored;
    }

    async versions(hospitalId: number, loc: Pick<RecordLocation, "reference" | "hiType" | "recordKey">): Promise<StoredPdf[]> {
        return this.deps.store.list(hospitalId, loc.reference, bundleIdOf(loc));
    }

    async version(hospitalId: number, loc: Pick<RecordLocation, "reference" | "hiType" | "recordKey">, versionId: string): Promise<Buffer | null> {
        const v = await this.deps.store.get(hospitalId, loc.reference, bundleIdOf(loc), versionId);
        return v ? this.deps.blobs.read(v.blobUrl) : null;
    }
}

export const recordPdfArchive = new RecordPdfArchive({
    owners: abdmRecordOwners,
    hips: () => abdmFacilities.hips(),
    store: abdmRecordPdfRepository,
    blobs: {
        upload: (path, data) => blobService.uploadPrivate(RECORD_PDF_CONTAINER, path, data, "application/pdf"),
        read: (url) => blobService.downloadFile(url),
    },
    bundles: (reference) => bundlesForReference(abdmHealthRecordService, reference),
    prescriptionVisit: async (id) => {
        const rows = await AppDataSource.query("SELECT AppointmentId FROM PatientPrescription WHERE Id = @0", [id]);
        const n = Number(String(rows[0]?.AppointmentId ?? "").trim());
        return Number.isInteger(n) && n > 0 ? n : null;
    },
    // Loaded when first needed: the catalog's module pulls in the whole of M2
    references: async (hip, patientId) => {
        const { careContextCatalog } = await import("./index.js");
        return (await careContextCatalog.refresh(hip, patientId)).map((r) => r.referenceNumber);
    },
});
