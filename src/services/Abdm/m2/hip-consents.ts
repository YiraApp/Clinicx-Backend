import type { HiType } from "../fhir/fhir-common.js";
import { HIU_PURPOSES } from "../hiu/hiu-enums.js";
import { patientReference } from "./care-contexts.js";
import type { ConsentRow, Hip, M2Store, TransferRow } from "./m2-store.js";

/**
 * Staff view of the consents ABDM has notified this HIP of for one patient, and what was pushed
 * under each. Read-only: the artefact and its signature never leave the database, and the
 * patient's ABHA address shows only its last four characters.
 */

export interface StoredHipConsent extends ConsentRow {
    createdAt: Date;
    updatedAt: Date | null;
}

export interface StoredHipTransfer {
    transactionId: string;
    consentId: string;
    status: TransferRow["status"];
    results: unknown;
    error: string | null;
    createdAt: Date;
    completedAt: Date | null;
}

/** What the view reads from AbdmConsents and AbdmDataTransfers. */
export interface HipConsentLedger {
    /** The HIP's consents that cover any care context of the patient, newest first. */
    consentsFor(hipId: string, patientReference: string): Promise<StoredHipConsent[]>;
    /** The transfers made under these consents, newest first. */
    transfersFor(hipId: string, consentIds: string[]): Promise<StoredHipTransfer[]>;
}

export type HipConsentStore = Pick<M2Store, "patient"> & HipConsentLedger;

export interface HipFacilities {
    hip(hospitalId: number | null | undefined): Promise<Hip | null>;
}

export interface TransferResultView {
    careContextReference: string;
    hiStatus: string;
    description: string | null;
}

export interface HipTransferView {
    transactionId: string;
    status: TransferRow["status"];
    requestedAt: string;
    completedAt: string | null;
    error: string | null;
    results: TransferResultView[];
    delivered: number;
    errored: number;
}

export interface HipConsentView {
    consentId: string;
    /** As ABDM last notified it: GRANTED, REVOKED or EXPIRED. */
    status: string;
    /** GRANTED and not past its erase date: a health information request under it would be served. */
    active: boolean;
    purpose: { code: string; text: string } | null;
    hiuId: string | null;
    patientAbhaAddress: string | null;
    hiTypes: HiType[];
    careContextReferences: string[];
    dateFrom: string | null;
    dateTo: string | null;
    dataEraseAt: string | null;
    receivedAt: string;
    updatedAt: string | null;
    transfers: HipTransferView[];
    delivered: number;
    errored: number;
}

export interface PatientHipConsents {
    hip: { id: string; name: string; hospitalId: number } | null;
    consents: HipConsentView[];
}

/** An ABHA address down to its last four characters. */
export const maskAbhaAddress = (address: string | null | undefined): string | null =>
    address ? `****${address.length > 4 ? address.slice(-4) : ""}` : null;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

const purposeOf = (code: string | null): HipConsentView["purpose"] => {
    if (!code) return null;
    return { code, text: HIU_PURPOSES.find((p) => p.code === code)?.text ?? code };
};

/** Results as data-flow stored them: one { careContextReference, hiStatus, description } per care context. */
const resultsOf = (raw: unknown): TransferResultView[] =>
    (Array.isArray(raw) ? raw : [])
        .filter((r) => r && typeof r === "object" && r.careContextReference)
        .map((r: any) => ({
            careContextReference: String(r.careContextReference),
            hiStatus: String(r.hiStatus ?? "UNKNOWN"),
            description: r.description ? String(r.description) : null,
        }));

const transferView = (t: StoredHipTransfer): HipTransferView => {
    const results = resultsOf(t.results);
    return {
        transactionId: t.transactionId,
        status: t.status,
        requestedAt: t.createdAt.toISOString(),
        completedAt: iso(t.completedAt),
        error: t.error,
        results,
        delivered: results.filter((r) => r.hiStatus === "DELIVERED").length,
        errored: results.filter((r) => r.hiStatus === "ERRORED").length,
    };
};

export class HipConsentsService {
    constructor(
        private readonly store: HipConsentStore,
        private readonly facilities: HipFacilities,
        private readonly now: () => Date = () => new Date(),
    ) {}

    /** The patient's consents at the hospital's HIP, newest first; null when there is no such patient. */
    async forPatient(hospitalId: number | null, userId: string): Promise<PatientHipConsents | null> {
        const patient = await this.store.patient(userId);
        if (!patient) return null;
        const hip = await this.facilities.hip(hospitalId);
        if (!hip) return { hip: null, consents: [] };

        const reference = patientReference(patient.userId);
        const consents = (await this.store.consentsFor(hip.id, reference))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const transfers = consents.length ? await this.store.transfersFor(hip.id, consents.map((c) => c.consentId)) : [];
        const now = this.now();

        return {
            hip: { id: hip.id, name: hip.name, hospitalId: hip.hospitalId },
            consents: consents.map((c) => {
                const under = transfers
                    .filter((t) => t.consentId === c.consentId)
                    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
                    .map(transferView);
                return {
                    consentId: c.consentId,
                    status: c.status,
                    active: c.status === "GRANTED" && (!c.dataEraseAt || c.dataEraseAt > now),
                    purpose: purposeOf(c.purpose),
                    hiuId: c.hiuId,
                    patientAbhaAddress: maskAbhaAddress(c.patientAbhaAddress),
                    hiTypes: c.hiTypes,
                    // Only this patient's: the patient reference itself is not repeated back
                    careContextReferences: c.careContexts
                        .filter((cc) => String(cc.patientReference ?? "").toLowerCase() === reference)
                        .map((cc) => String(cc.careContextReference)),
                    dateFrom: iso(c.dateFrom),
                    dateTo: iso(c.dateTo),
                    dataEraseAt: iso(c.dataEraseAt),
                    receivedAt: c.createdAt.toISOString(),
                    updatedAt: iso(c.updatedAt),
                    transfers: under,
                    delivered: under.reduce((n, t) => n + t.delivered, 0),
                    errored: under.reduce((n, t) => n + t.errored, 0),
                };
            }),
        };
    }
}
