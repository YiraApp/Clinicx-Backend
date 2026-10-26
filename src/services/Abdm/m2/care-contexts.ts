import type { HiType } from "../fhir/fhir-common.js";
import { diagnosticKind, visitSources } from "../abdm-health-record.service.js";
import { abdmHealthRecordRepository, type AbdmHealthRecordRepository } from "../../../repositories/Abdm/abdm-health-record.repository.js";
import type { CareContextKind, CareContextRow, CareContextSeed, Hip, M2Store } from "./m2-store.js";

/**
 * A patient's care contexts at this HIP, as ABDM recommends grouping them: one per outpatient visit,
 * one per inpatient stay (a Final discharge summary), and one per record made outside a visit
 * (an immunization, a vitals check, a prescription, a consultation record, a clinical note, an
 * uploaded document), so each reaches the patient's PHR app on its own. Each has a reference this
 * system resolves and a display a person recognises months later, with no diagnosis or result in it.
 */

const REFERENCE_PREFIX: Record<CareContextKind, string> = {
    visit: "OP", discharge: "IP", immunization: "IM", vitals: "VT", prescription: "RX", consultation: "MR", note: "CN", document: "DOC",
};

export const careContextReference = (kind: CareContextKind, sourceId: string | number): string => `${REFERENCE_PREFIX[kind]}-${sourceId}`;

export const parseCareContextReference = (ref: string): { kind: CareContextKind; sourceId: string } | null => {
    const match = ref.match(/^(OP|IP|IM|VT|RX|MR|CN|DOC)-(.+)$/);
    if (!match) return null;
    const kind = (Object.entries(REFERENCE_PREFIX).find(([, prefix]) => prefix === match[1])![0]) as CareContextKind;
    return { kind, sourceId: match[2]! };
};

const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

/** What the patient sees in their PHR app: the kind of encounter and its date, never its content. */
export const careContextDisplay = (kind: CareContextKind, date: Date, options: { until?: Date; teleconsultation?: boolean; category?: string | null } = {}): string => {
    switch (kind) {
        case "visit": return `${options.teleconsultation ? "Teleconsultation" : "OPD visit"}, ${day(date)}`;
        case "discharge": return `Hospital stay, ${day(date)}${options.until ? ` to ${day(options.until)}` : ""}`;
        case "immunization": return `Vaccination, ${day(date)}`;
        case "vitals": return `Vitals check, ${day(date)}`;
        case "prescription": return `Prescription, ${day(date)}`;
        case "consultation": return `Consultation record, ${day(date)}`;
        case "note": return `Clinical note, ${day(date)}`;
        // The kind of document only: its title or file name may name a condition
        case "document": {
            const kind = diagnosticKind(options.category);
            return `${kind === "lab" ? "Lab report" : kind === "imaging" ? "Imaging report" : "Health document"}, ${day(date)}`;
        }
    }
};

/** The ABDM patient reference: this system's patient id. */
export const patientReference = (userId: string): string => userId.toLowerCase();

export class CareContextCatalog {
    constructor(
        private readonly store: M2Store,
        private readonly records: Pick<AbdmHealthRecordRepository, "visit" | "standaloneRecordIds" | "standaloneRecords" | "dischargeSummary" | "immunization" | "vitalsRecord"> = abdmHealthRecordRepository,
    ) {}

    /** Recomputes what each care context at this facility holds from the records, keeps link state, and returns them all. */
    async refresh(hip: Hip, patientUserId: string): Promise<CareContextRow[]> {
        const seeds: CareContextSeed[] = [];
        const seed = (kind: CareContextKind, sourceId: string | number, recordDate: Date, display: string, hiTypes: HiType[]) => {
            if (!hiTypes.length) return;
            seeds.push({
                hipId: hip.id, referenceNumber: careContextReference(kind, sourceId), patientUserId: patientReference(patientUserId),
                hospitalId: hip.hospitalId, kind, sourceId: String(sourceId), recordDate, display, hiTypes,
            });
        };

        for (const appointmentId of await this.store.appointmentIds(patientUserId, hip.hospitalId)) {
            try {
                const visit = await this.records.visit(appointmentId, { files: false });
                const hiTypes = [...new Set(visitSources(visit).map((s) => s.hiType))];
                seed("visit", appointmentId, visit.appointment.start, careContextDisplay("visit", visit.appointment.start, { teleconsultation: visit.appointment.teleconsultation }), hiTypes);
            } catch (error: any) {
                console.warn(`[ABDM] visit ${appointmentId} left out of care contexts: ${error?.message}`);
            }
        }

        const standalone = await this.records.standaloneRecordIds(patientUserId, hip.hospitalId);
        for (const id of standalone.dischargeSummaryIds) {
            const { summary } = await this.records.dischargeSummary(id);
            seed("discharge", id, summary.DischargedAt, careContextDisplay("discharge", summary.AdmittedAt, { until: summary.DischargedAt }), ["DischargeSummary"]);
        }
        for (const id of standalone.immunizationIds) {
            const { row } = await this.records.immunization(id);
            const date = new Date(row.AdministeredOn);
            seed("immunization", id, date, careContextDisplay("immunization", date), ["ImmunizationRecord"]);
        }
        for (const id of standalone.vitalsRecordIds) {
            const { row } = await this.records.vitalsRecord(id);
            const date = new Date(row.Date);
            seed("vitals", id, date, careContextDisplay("vitals", date), ["WellnessRecord"]);
        }

        const other = await this.records.standaloneRecords(patientUserId, hip.hospitalId);
        for (const p of other.prescriptions) seed("prescription", p.id, p.date, careContextDisplay("prescription", p.date), ["Prescription"]);
        for (const r of other.consultations) seed("consultation", r.id, r.date, careContextDisplay("consultation", r.date), ["OPConsultation"]);
        for (const n of other.notes) seed("note", n.id, n.date, careContextDisplay("note", n.date), ["OPConsultation"]);
        for (const d of other.documents) {
            seed("document", d.id, d.date, careContextDisplay("document", d.date, { category: d.category }), [diagnosticKind(d.category) ? "DiagnosticReport" : "HealthDocumentRecord"]);
        }

        await this.store.upsertCareContexts(seeds);
        return this.store.careContexts(patientReference(patientUserId), hip.id);
    }
}

/** ABDM's patient[] shape: one entry per HI type, with the care contexts holding it and their count. */
export const byHiType = (patientRef: string, patientDisplay: string, contexts: Pick<CareContextRow, "referenceNumber" | "display" | "hiTypes">[]) => {
    const groups = new Map<HiType, Array<{ referenceNumber: string; display: string }>>();
    for (const c of contexts) {
        for (const hiType of c.hiTypes) {
            groups.set(hiType, [...(groups.get(hiType) ?? []), { referenceNumber: c.referenceNumber, display: c.display }]);
        }
    }
    return [...groups.entries()].map(([hiType, careContexts]) => ({
        referenceNumber: patientRef,
        display: patientDisplay,
        careContexts,
        hiType,
        count: careContexts.length,
    }));
};
