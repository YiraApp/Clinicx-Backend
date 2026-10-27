import type { EntitySubscriberInterface, InsertEvent, UpdateEvent } from "typeorm/index.js";
import type { RecordRef } from "./auto-link.js";

/**
 * Tells the auto-linker about every saved row that can hold health information, whichever screen
 * or API saved it (web or mobile). Registered on the DataSource at startup. Raw SQL writes are not
 * seen; the only ones on these tables set a PDF's address, which shares nothing new.
 */

/** Tables whose rows carry PatientId, HospitalId and, for visit records, AppointmentId. */
const RECORD_TABLES = new Set([
    "PatientMedicalRecord", "PatientPrescription", "PatientClinicalNotes", "MedicalDocuments",
    "AppointmentBills", "PatientImmunizations", "DischargeSummaries", "PostVisitDocuments", "DiagnosticReports", "WellnessRecords",
]);
/** An update that names no owner is followed up through the table's recently updated rows. */
const RECENT_WINDOW_MS = 60_000;
/** Tables whose rows only name their prescription. */
const PRESCRIPTION_PARTS = new Set(["PrescriptionMedication", "PrescriptionDiagnosis"]);

const text = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());
const int = (v: unknown): number | null => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** Whose a saved row is, as far as the row says; null for a table that holds no health information. */
export const recordRefOf = (table: string, row: any): RecordRef | null => {
    if (!row) return null;
    if (PRESCRIPTION_PARTS.has(table)) {
        const prescriptionId = text(row.PrescriptionId);
        return prescriptionId ? { prescriptionId } : null;
    }
    if (!RECORD_TABLES.has(table)) return null;
    const ref: RecordRef = { patientId: text(row.PatientId), hospitalId: int(row.HospitalId), appointmentId: int(row.AppointmentId) };
    return ref.appointmentId || (ref.patientId && ref.hospitalId) ? ref : null;
};

export class AbdmRecordSubscriber implements EntitySubscriberInterface<any> {
    constructor(private readonly onSaved: (ref: RecordRef) => void) {}

    afterInsert(event: InsertEvent<any>) {
        this.seen(event.metadata.tableName, event.entity);
    }

    afterUpdate(event: UpdateEvent<any>) {
        // An update by criteria carries only the changed columns; the loaded row fills in the rest when
        // there is one. When neither names the owner (a bill marked Paid by its id), the table's rows
        // updated in the last minute are looked up once the save has committed.
        const table = event.metadata.tableName;
        this.seen(table, { ...(event.databaseEntity ?? {}), ...(event.entity ?? {}) }, RECORD_TABLES.has(table));
    }

    private seen(table: string, row: any, followRecent = false) {
        try {
            const ref = recordRefOf(table, row) ?? (followRecent ? { recentIn: table, since: new Date(Date.now() - RECENT_WINDOW_MS) } : null);
            if (ref) this.onSaved(ref);
        } catch (error: any) {
            // Never fail the save that told us
            console.warn(`[ABDM] a saved ${table} row could not be queued for linking: ${error?.message}`);
        }
    }
}
