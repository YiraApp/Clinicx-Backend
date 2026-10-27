import { abdmFacilityRepository, abdmSettingsRepository } from "../../repositories/Abdm/abdm-facility.repository.js";

/**
 * ABDM per tenant. One client id and one bridge serve the whole deployment (those stay in the
 * environment); each hospital that shares records is its own HFR facility, linked to that bridge
 * as HIP, and its settings live in the database (AbdmFacilities). A request from staff names the
 * hospital (X-Hospital-Id); a callback from ABDM names the facility (X-HIP-ID, or X-HIU-ID for M3);
 * both resolve here. A hospital requests records (M3) as its HIU id, which is its HIP id unless set apart.
 *
 * Deployment-wide values that are not secrets (the bridge URL, the callers allowed on our
 * callbacks) live in AbdmSettings.
 */

export interface AbdmFacility {
    hospitalId: number;
    /** HFR facility id, sent as X-HIP-ID on every M2 call (IN and 10 digits); null when the hospital has none yet. */
    hipId: string | null;
    /** The facility's name as patients see it (ABDM's SMS, the staff screen); falls back to the HIP id. */
    name: string;
    /** HIP id on this hospital's Scan and Share counter QR codes, when it is not the HFR id. */
    scanShareHipId: string | null;
    /**
     * HFR facility id the hospital requests records as (M3, X-HIU-ID), when it is not the HIP id;
     * null means the HIP id (ABDM registers a facility as HIP and HIU together). See hiuIdOf.
     */
    hiuId: string | null;
    /** Link new care contexts and announce new records on the scheduled sweep. */
    autoLink: boolean;
}

/** The facility an M2 call acts for: its HFR id (X-HIP-ID), the hospital whose records it shares, its name. */
export interface Hip {
    id: string;
    hospitalId: number;
    name: string;
}

/** The facility an M3 (HIU) call acts for: its HFR id (X-HIU-ID, consent.hiu.id), the hospital that asks, its name. */
export interface Hiu {
    id: string;
    hospitalId: number;
    name: string;
}

export interface FacilityInput {
    hipId?: string | null;
    hiuId?: string | null;
    hipName?: string | null;
    scanShareHipId?: string | null;
    autoLink?: boolean;
    isActive?: boolean;
}

export interface FacilityStore {
    /** Active facilities. */
    list(): Promise<AbdmFacility[]>;
    save(hospitalId: number, input: FacilityInput, userId: string | null): Promise<void>;
    /**
     * Record requests (M3) [hospitalId] raised as [hiuId] that ABDM may still answer: open, granted
     * and still in force, or with a transfer under way. ABDM answers them to that X-HIU-ID.
     */
    openHiuRequests?(hospitalId: number, hiuId: string): Promise<number>;
}

export type AbdmSettingName = "BridgeUrl" | "CallbackClientIds";

export interface SettingsStore {
    get(name: AbdmSettingName): Promise<string | null>;
    set(name: AbdmSettingName, value: string): Promise<void>;
}

export class FacilityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FacilityError";
    }
}

/** An id another hospital already uses (409, as the unique indexes answer). */
export class FacilityClashError extends FacilityError {
    constructor(message: string) {
        super(message);
        this.name = "FacilityClashError";
    }
}

/** An HFR facility id: what ABDM accepts as X-HIP-ID on M2 calls. */
export const HFR_ID = /^IN\d{10}$/;

/** The HIP id a hospital's Scan and Share counters put on their QR code. */
export const scanShareHipIdOf = (f: AbdmFacility): string | null => f.scanShareHipId ?? f.hipId;

const hipOf = (f: AbdmFacility): Hip | null => (f.hipId ? { id: f.hipId, hospitalId: f.hospitalId, name: f.name } : null);

/** The HIU id a hospital requests records as: its own HIU id, else its HIP id; null when it has neither. */
export const hiuIdOf = (f: AbdmFacility): string | null => f.hiuId ?? f.hipId;

const hiuOf = (f: AbdmFacility): Hiu | null => {
    const id = hiuIdOf(f);
    if (!id) return null;
    // With no name saved, the name falls back to the HIP id: an HIU set apart is named by its own id.
    return { id, hospitalId: f.hospitalId, name: f.hiuId && f.name === f.hipId ? f.hiuId : f.name || id };
};

const CACHE_MS = 60_000;

/** Facilities change rarely and every callback reads them: kept for a minute, dropped on a save. */
export class AbdmFacilityDirectory {
    private cached: { at: number; facilities: AbdmFacility[] } | null = null;
    /** Bumped on every save: a read that started before it is used once, never cached. */
    private generation = 0;

    constructor(
        private readonly store: FacilityStore,
        private readonly now: () => number = Date.now,
    ) {}

    async all(): Promise<AbdmFacility[]> {
        if (this.cached && this.now() - this.cached.at <= CACHE_MS) return this.cached.facilities;
        const generation = this.generation;
        const facilities = await this.store.list();
        if (generation === this.generation) this.cached = { at: this.now(), facilities };
        return facilities;
    }

    async byHospital(hospitalId: number | null | undefined): Promise<AbdmFacility | null> {
        if (!hospitalId) return null;
        return (await this.all()).find((f) => f.hospitalId === hospitalId) ?? null;
    }

    /** Every hospital that acts as an HIP for M2 (it has an HFR facility id); only those with AutoLink on, when asked. */
    async hips(options: { autoLink?: boolean } = {}): Promise<Hip[]> {
        return (await this.all())
            .filter((f) => !options.autoLink || f.autoLink)
            .map(hipOf)
            .filter((h): h is Hip => h !== null);
    }

    /** The HIP a hospital's staff act for, or null when the hospital has no HFR facility id. */
    async hip(hospitalId: number | null | undefined): Promise<Hip | null> {
        const f = await this.byHospital(hospitalId);
        return f ? hipOf(f) : null;
    }

    /** The HIP an M2 callback is for, by its X-HIP-ID. */
    async hipById(hipId: string | null | undefined): Promise<Hip | null> {
        if (!hipId) return null;
        return (await this.hips()).find((h) => h.id === hipId) ?? null;
    }

    /**
     * The HIU a hospital's staff request records as (M3), or null when the hospital has no HIU id
     * (nor HIP id). Never another hospital's id, never a deployment-wide one.
     */
    async hiu(hospitalId: number | null | undefined): Promise<Hiu | null> {
        const f = await this.byHospital(hospitalId);
        return f ? hiuOf(f) : null;
    }

    /** The HIU an M3 callback is for, by its X-HIU-ID; null when no hospital, or more than one, acts as it. */
    async hiuById(hiuId: string | null | undefined): Promise<Hiu | null> {
        if (!hiuId) return null;
        const matches = (await this.all()).filter((f) => hiuIdOf(f) === hiuId);
        return matches.length === 1 ? hiuOf(matches[0]!) : null;
    }

    /** The hospital a Scan and Share profile is for, by the HIP id on the counter's QR code. */
    async byScanShareHipId(hipId: string | null | undefined): Promise<AbdmFacility | null> {
        if (!hipId) return null;
        return (await this.all()).find((f) => scanShareHipIdOf(f) === hipId) ?? null;
    }

    async save(hospitalId: number, input: FacilityInput, userId: string | null): Promise<AbdmFacility | null> {
        // A facility switched off keeps no ids: the unique indexes ignore IsActive, so ids left on an
        // inactive row would stay reserved, unseen, against every other hospital.
        const isActive = input.isActive !== false;
        const hipId = isActive ? String(input.hipId ?? "").trim().toUpperCase() || null : null;
        if (hipId && !HFR_ID.test(hipId)) throw new FacilityError("The HIP id must be the hospital's HFR facility id: IN followed by 10 digits.");
        const scanShareHipId = isActive ? String(input.scanShareHipId ?? "").trim() || null : null;
        if (scanShareHipId && scanShareHipId.length > 50) throw new FacilityError("The Scan and Share HIP id is too long.");
        const hiuId = isActive ? String(input.hiuId ?? "").trim().toUpperCase() || null : null;
        if (hiuId && !HFR_ID.test(hiuId)) throw new FacilityError("The HIU id must be an HFR facility id: IN followed by 10 digits.");
        if (isActive && !hipId && !scanShareHipId && !hiuId) throw new FacilityError("Give the hospital's HFR facility id, an HIU id, or a Scan and Share HIP id.");
        const hipName = String(input.hipName ?? "").trim() || null;
        if (hipName && hipName.length > 100) throw new FacilityError("The facility name is too long.");
        const facilities = await this.store.list();
        // One HIU id serves one hospital (a hospital with no HIU id of its own asks as its HIP id), and
        // an HFR facility belongs to one hospital: a callback's X-HIU-ID must lead to one tenant only.
        const ownHiuId = hiuId ?? hipId;
        if (ownHiuId) {
            const taken = facilities.find((f) => f.hospitalId !== hospitalId
                && (hiuIdOf(f) === ownHiuId || f.hipId === ownHiuId || (hipId !== null && f.hiuId === hipId)));
            if (taken) {
                const clashId = hiuIdOf(taken) === ownHiuId || taken.hipId === ownHiuId ? ownHiuId : hipId;
                throw new FacilityClashError(clashId === hiuId
                    ? `HIU id ${hiuId} clashes with the ABDM facility of hospital ${taken.hospitalId}.`
                    : `HFR facility id ${clashId} is already used by another hospital (hospital ${taken.hospitalId}).`);
            }
        }
        // ABDM answers a record request to the HIU id it was raised as: while any is still open, the
        // hospital keeps that id (a new one, or none, would leave those answers refused).
        const before = facilities.find((f) => f.hospitalId === hospitalId);
        const oldHiuId = before ? hiuIdOf(before) : null;
        if (oldHiuId && oldHiuId !== ownHiuId && this.store.openHiuRequests && (await this.store.openHiuRequests(hospitalId, oldHiuId)) > 0) {
            throw new FacilityError(`Hospital ${hospitalId} has ABDM record requests still open as HIU ${oldHiuId}, and ABDM answers them to that id: keep it until they are settled.`);
        }
        await this.store.save(hospitalId, { ...input, hipId, hiuId, hipName, scanShareHipId }, userId);
        this.generation++;
        this.cached = null;
        return this.byHospital(hospitalId);
    }
}

/** Deployment-wide ABDM values, read on every use so a change from the admin screen applies at once. */
export class AbdmSettings {
    constructor(private readonly store: SettingsStore) {}

    async bridgeUrl(): Promise<string> {
        return ((await this.store.get("BridgeUrl")) ?? "").trim().replace(/\/+$/, "");
    }

    setBridgeUrl(url: string): Promise<void> {
        return this.store.set("BridgeUrl", url);
    }

    /**
     * ABDM client ids allowed to call our callbacks. Empty refuses every callback: the refusal's
     * log names the caller's client id, to add here.
     */
    async callbackClientIds(): Promise<string[]> {
        return ((await this.store.get("CallbackClientIds")) ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    }
}

export const abdmFacilities = new AbdmFacilityDirectory(abdmFacilityRepository);
export const abdmSettings = new AbdmSettings(abdmSettingsRepository);
