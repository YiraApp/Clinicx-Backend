/**
 * Front Desk removes a patient from their own hospital, brings a removed patient back, and unlinks
 * a patient's ABHA. Nothing is deleted: the patient's link to the hospital (their Patient row in
 * UserRoles) is marked IsDeleted, with UpdatedBy = who removed them and UpdatedAt = when, and that
 * row is what the "Deleted patients" page lists. The account, and the patient's links to other
 * hospitals, are left as they are.
 *
 * Only a Front Desk user of that hospital may do any of this, and only for that hospital's patients.
 * The database work is behind HospitalPatientStore, so the rules here are tested without one.
 */

/** The patient's links at one hospital and in its organization, as the store reads them. */
export interface PatientHospitalLinks {
    /** The hospital's organization (null for a hospital without one). */
    organizationId: number | null;
    /** The patient's live (IsDeleted = 0) Patient rows in UserRoles at this hospital. */
    roleIdsHere: number[];
    /** Other hospitals of the same organization where the patient has an active Patient row. */
    otherHospitalIds: number[];
    /** The patient's live registrations in the organization (one per organization, as a rule). */
    registrations: { id: number; hospitalId: number | null }[];
}

/** What a removal marks: Patient rows and registrations deleted, or registrations moved to a hospital the patient stays at. */
export interface RemovalPlan {
    roleIds: number[];
    deleteRegistrationIds: number[];
    moveRegistrations: { id: number; hospitalId: number }[];
}

/** The latest removal of a patient from a hospital: the deleted Patient row in UserRoles. */
export interface RemovedLink {
    userRoleId: number;
    userId: string;
    roleId: string;
    organizationId: number | null;
    hospitalId: number;
    removedAt: Date | null;
    removedBy: string | null;
}

export interface RemovedPatientRow {
    userId: string;
    firstName: string | null;
    lastName: string | null;
    gender: string | null;
    dateOfBirth: string | Date | null;
    phone: string | null;
    tokenNumber: string | null;
    removedAt: Date | null;
    removedById: string | null;
    removedByName: string | null;
}

export interface RemovedPatientQuery {
    hospitalId: number;
    page: number;
    pageSize: number;
    search?: string;
}

export interface HospitalPatientStore {
    /** Whether the user holds an active Front Desk role at the hospital. */
    isFrontDeskAt(userId: string, hospitalId: number): Promise<boolean>;
    /** The hospital's organization; undefined when there is no such live hospital. */
    hospitalOrganization(hospitalId: number): Promise<number | null | undefined>;
    /** The patient's links; null when there is no live account with that id. */
    patientLinks(userId: string, hospitalId: number, organizationId: number | null): Promise<PatientHospitalLinks | null>;
    /** Marks the plan's rows, stamped with who and when, in one transaction. */
    applyRemoval(plan: RemovalPlan, actorId: string, at: Date): Promise<void>;
    /** The patient's latest removal from the hospital by a staff member, or null. */
    latestRemoval(userId: string, hospitalId: number): Promise<RemovedLink | null>;
    /** Gives the patient a live Patient row at the hospital again, and their registration back. */
    restore(link: RemovedLink, actorId: string, at: Date): Promise<void>;
    /** Patients removed from the hospital and not back there since, latest removal first. */
    listRemoved(query: RemovedPatientQuery): Promise<{ rows: RemovedPatientRow[]; total: number }>;
    /** The ABHA linked to the account; null when there is no live account. */
    abhaOf(userId: string): Promise<{ abhaNumber: string | null; abhaAddresses: string[] } | null>;
    /** Takes the ABHA off the account, in one transaction. */
    unlinkAbha(userId: string, actorId: string, at: Date): Promise<void>;
}

/** A refusal the controller answers with [status] and [message]. */
export class PatientRemovalError extends Error {
    constructor(public readonly status: 400 | 403 | 404 | 409, message: string) {
        super(message);
        this.name = "PatientRemovalError";
    }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sameId = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

/** "******1234": the last 4 digits of a phone number, or null. */
export const maskPhone = (phone: string | null | undefined): string | null => {
    const digits = (phone || "").replace(/\D/g, "");
    return digits.length >= 4 ? `******${digits.slice(-4)}` : null;
};

/**
 * Which rows a removal marks. The patient's Patient rows at this hospital are always marked deleted.
 * Their registration belongs to the whole organization: it is marked deleted too when they have no
 * active Patient row left at another hospital of that organization. Otherwise it stays, and one that
 * named this hospital is moved to a hospital they stay at, so this hospital's list (which also matches
 * a registration naming the hospital) no longer shows them.
 */
export function planRemoval(hospitalId: number, links: PatientHospitalLinks): RemovalPlan {
    const remaining = [...new Set(links.otherHospitalIds.filter((id) => id !== hospitalId))];
    if (remaining.length === 0) {
        return { roleIds: [...links.roleIdsHere], deleteRegistrationIds: links.registrations.map((r) => r.id), moveRegistrations: [] };
    }
    return {
        roleIds: [...links.roleIdsHere],
        deleteRegistrationIds: [],
        moveRegistrations: links.registrations
            .filter((r) => r.hospitalId === hospitalId)
            .map((r) => ({ id: r.id, hospitalId: remaining[0]! })),
    };
}

export class HospitalPatientRemovalService {
    constructor(private readonly store: HospitalPatientStore, private readonly now: () => Date = () => new Date()) {}

    private checkIds(actorId: string | undefined, hospitalId: number, userId?: string): asserts actorId is string {
        if (!actorId) throw new PatientRemovalError(403, "Sign in as Front Desk to do this.");
        if (!Number.isInteger(hospitalId) || hospitalId <= 0) throw new PatientRemovalError(400, "Choose your hospital first.");
        if (userId !== undefined && !GUID.test(userId)) throw new PatientRemovalError(400, "The patient id is not valid.");
    }

    private async requireFrontDesk(actorId: string, hospitalId: number): Promise<void> {
        if (!(await this.store.isFrontDeskAt(actorId, hospitalId))) {
            throw new PatientRemovalError(403, "Only Front Desk at this hospital can manage its patients.");
        }
    }

    /** The patient's links at the hospital; refuses one with no live Patient row there. */
    private async linksAt(userId: string, hospitalId: number): Promise<PatientHospitalLinks> {
        const organizationId = await this.store.hospitalOrganization(hospitalId);
        if (organizationId === undefined) throw new PatientRemovalError(404, "This hospital was not found.");
        const links = await this.store.patientLinks(userId, hospitalId, organizationId);
        if (!links || links.roleIdsHere.length === 0) {
            throw new PatientRemovalError(404, "This patient is not registered at your hospital.");
        }
        return links;
    }

    /** Removes the patient from the hospital (soft delete). */
    async remove(actorId: string | undefined, userId: string, hospitalId: number) {
        this.checkIds(actorId, hospitalId, userId);
        await this.requireFrontDesk(actorId, hospitalId);
        if (sameId(actorId, userId)) throw new PatientRemovalError(400, "You can't remove your own account.");
        const links = await this.linksAt(userId, hospitalId);
        const at = this.now();
        await this.store.applyRemoval(planRemoval(hospitalId, links), actorId, at);
        return { userId, hospitalId, removedAt: at, removedBy: actorId };
    }

    /** Brings a removed patient back to the hospital. */
    async restore(actorId: string | undefined, userId: string, hospitalId: number) {
        this.checkIds(actorId, hospitalId, userId);
        await this.requireFrontDesk(actorId, hospitalId);
        const organizationId = await this.store.hospitalOrganization(hospitalId);
        if (organizationId === undefined) throw new PatientRemovalError(404, "This hospital was not found.");
        const links = await this.store.patientLinks(userId, hospitalId, organizationId);
        if (!links) throw new PatientRemovalError(404, "This patient's account was not found.");
        if (links.roleIdsHere.length > 0) throw new PatientRemovalError(409, "This patient is already registered at your hospital.");
        const removal = await this.store.latestRemoval(userId, hospitalId);
        if (!removal) throw new PatientRemovalError(404, "This patient was not removed from your hospital.");
        const at = this.now();
        await this.store.restore(removal, actorId, at);
        return { userId, hospitalId, restoredAt: at, restoredBy: actorId };
    }

    /** The hospital's removed patients, with who removed them and when. Phone numbers go out masked. */
    async listRemoved(actorId: string | undefined, hospitalId: number, page = 1, pageSize = 20, search?: string) {
        this.checkIds(actorId, hospitalId);
        await this.requireFrontDesk(actorId, hospitalId);
        const safePage = Number.isInteger(page) && page > 0 ? page : 1;
        const safeSize = Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20;
        const term = (search || "").trim().slice(0, 100);
        const { rows, total } = await this.store.listRemoved({ hospitalId, page: safePage, pageSize: safeSize, search: term || undefined });
        return {
            patients: rows.map((row) => ({
                userId: row.userId,
                name: `${row.firstName || ""} ${row.lastName || ""}`.trim() || "Unnamed patient",
                gender: row.gender,
                dateOfBirth: row.dateOfBirth,
                phone: maskPhone(row.phone),
                tokenNumber: row.tokenNumber,
                removedAt: row.removedAt,
                removedBy: { id: row.removedById, name: row.removedByName },
            })),
            total,
            page: safePage,
            pageSize: safeSize,
            totalPages: Math.max(1, Math.ceil(total / safeSize)),
        };
    }

    /** Takes the patient's ABHA off their account. The ABHA is the account's, so this applies at every hospital. */
    async unlinkAbha(actorId: string | undefined, userId: string, hospitalId: number) {
        this.checkIds(actorId, hospitalId, userId);
        await this.requireFrontDesk(actorId, hospitalId);
        await this.linksAt(userId, hospitalId);
        const abha = await this.store.abhaOf(userId);
        if (!abha || (!abha.abhaNumber && abha.abhaAddresses.length === 0)) {
            throw new PatientRemovalError(400, "No ABHA is linked to this patient.");
        }
        await this.store.unlinkAbha(userId, actorId, this.now());
        const digits = (abha.abhaNumber || "").replace(/\D/g, "");
        return { userId, abhaNumberLast4: digits.length >= 4 ? digits.slice(-4) : null };
    }
}
