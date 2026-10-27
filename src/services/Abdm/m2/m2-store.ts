import type { HiType } from "../fhir/fhir-common.js";
import type { Hip } from "../abdm-facilities.service.js";

export type { Hip };

/**
 * What M2 keeps between ABDM's calls: care contexts and how far each is linked, link tokens,
 * links a patient started (waiting on an OTP), consents, and data transfers.
 * AbdmM2Repository implements it on SQL Server; tests use an in-memory one.
 */

/** A visit, or a record saved outside one, which is then a care context of its own. */
export type CareContextKind = "visit" | "discharge" | "immunization" | "vitals" | "prescription" | "consultation" | "note" | "document" | "report" | "wellness";
export type LinkStatus = "not-linked" | "awaiting-token" | "linking" | "linked" | "failed";

export interface CareContextSeed {
    hipId: string;
    referenceNumber: string;
    patientUserId: string;
    hospitalId: number;
    kind: CareContextKind;
    sourceId: string;
    recordDate: Date;
    display: string;
    hiTypes: HiType[];
}

export interface CareContextRow extends CareContextSeed {
    id: number;
    linkStatus: LinkStatus;
    linkedVia: "hip" | "patient" | null;
    linkedAbhaAddress: string | null;
    linkRequestId: string | null;
    linkedAt: Date | null;
    notifiedHiTypes: HiType[];
    lastError: string | null;
    /** When the clinic's record first became a care context: soon after it was saved. */
    createdAt?: Date | null;
}

export type LinkStatePatch = Partial<Pick<CareContextRow, "linkStatus" | "linkedVia" | "linkedAbhaAddress" | "linkRequestId" | "linkedAt" | "notifiedHiTypes" | "lastError">>;

export interface PatientProfile {
    userId: string;
    name: string;
    gender: string | null;
    birthDate: string | null;
    phone: string | null;
    abhaNumber: string | null;
    abhaAddress: string | null;
}

export interface LinkRequestRow {
    linkRefNumber: string;
    transactionId: string;
    hipId: string;
    patientUserId: string;
    abhaAddress: string;
    careContextRefs: string[];
    otpHash: string;
    otpExpiresAt: Date;
    attempts: number;
    status: "pending" | "linked" | "expired" | "failed";
}

export interface ConsentRow {
    consentId: string;
    hipId: string;
    status: string;
    patientAbhaAddress: string | null;
    hiuId: string | null;
    hiTypes: HiType[];
    careContexts: Array<{ patientReference: string; careContextReference: string }>;
    dateFrom: Date | null;
    dateTo: Date | null;
    dataEraseAt: Date | null;
    purpose: string | null;
}

export interface TransferRow {
    transactionId: string;
    consentId: string;
    hipId: string;
    requestId: string;
    dataPushUrl: string | null;
    status: "received" | "acknowledged" | "transferred" | "failed" | "refused";
    results?: unknown;
    error?: string | null;
}

export interface M2Store {
    patient(userId: string): Promise<PatientProfile | null>;
    /** Patients registered at the hospital who match any criterion given. */
    patientsAt(hospitalId: number, criteria: { abhaAddress?: string; abhaNumber?: string; mobile?: string; userId?: string }): Promise<PatientProfile[]>;
    /** Every ABHA address the patient holds, lower case: one ABHA number can carry several. */
    abhaAddresses(userId: string): Promise<string[]>;
    /** Patients registered at the hospital who hold an ABHA address. */
    patientsWithAbhaAt(hospitalId: number): Promise<string[]>;
    appointmentIds(patientUserId: string, hospitalId: number): Promise<number[]>;

    upsertCareContexts(seeds: CareContextSeed[]): Promise<void>;
    careContexts(patientUserId: string, hipId: string): Promise<CareContextRow[]>;
    careContextsByRefs(hipId: string, refs: string[]): Promise<CareContextRow[]>;
    careContextsByLinkRequest(requestId: string): Promise<CareContextRow[]>;
    setLinkState(ids: number[], patch: LinkStatePatch): Promise<void>;

    linkToken(patientUserId: string, hipId: string, validAfter: Date): Promise<{ token: string; abhaAddress: string; expiresAt: Date } | null>;
    saveLinkToken(row: { patientUserId: string; hipId: string; abhaAddress: string; token: string; expiresAt: Date; requestId: string }): Promise<void>;
    dropLinkTokens(patientUserId: string, hipId: string): Promise<void>;

    createLinkRequest(row: LinkRequestRow): Promise<void>;
    linkRequest(linkRefNumber: string): Promise<LinkRequestRow | null>;
    updateLinkRequest(linkRefNumber: string, patch: Partial<Pick<LinkRequestRow, "attempts" | "status">>): Promise<void>;

    saveConsent(row: ConsentRow & { artefact: string | null; signature: string | null }): Promise<void>;
    consent(consentId: string): Promise<ConsentRow | null>;

    /** "duplicate" when ABDM delivers the same transaction again. */
    createTransfer(row: TransferRow): Promise<"created" | "duplicate">;
    updateTransfer(transactionId: string, patch: Partial<Pick<TransferRow, "status" | "results" | "error">> & { completed?: boolean }): Promise<void>;
}
