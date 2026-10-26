import { abdmFacilityRepository, abdmSettingsRepository } from "../../repositories/Abdm/abdm-facility.repository.js";

/**
 * ABDM per tenant. One client id and one bridge serve the whole deployment (those stay in the
 * environment); each hospital that shares records is its own HFR facility, linked to that bridge
 * as HIP, and its settings live in the database (AbdmFacilities). A request from staff names the
 * hospital (X-Hospital-Id); a callback from ABDM names the facility (X-HIP-ID); both resolve here.
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
    /** Link new care contexts and announce new records on the scheduled sweep. */
    autoLink: boolean;
}

/** The facility an M2 call acts for: its HFR id (X-HIP-ID), the hospital whose records it shares, its name. */
export interface Hip {
    id: string;
    hospitalId: number;
    name: string;
}

export interface FacilityInput {
    hipId?: string | null;
    hipName?: string | null;
    scanShareHipId?: string | null;
    autoLink?: boolean;
    isActive?: boolean;
}

export interface FacilityStore {
    /** Active facilities. */
    list(): Promise<AbdmFacility[]>;
    save(hospitalId: number, input: FacilityInput, userId: string | null): Promise<void>;
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

/** An HFR facility id: what ABDM accepts as X-HIP-ID on M2 calls. */
export const HFR_ID = /^IN\d{10}$/;

/** The HIP id a hospital's Scan and Share counters put on their QR code. */
export const scanShareHipIdOf = (f: AbdmFacility): string | null => f.scanShareHipId ?? f.hipId;

const hipOf = (f: AbdmFacility): Hip | null => (f.hipId ? { id: f.hipId, hospitalId: f.hospitalId, name: f.name } : null);

const CACHE_MS = 60_000;

/** Facilities change rarely and every callback reads them: kept for a minute, dropped on a save. */
export class AbdmFacilityDirectory {
    private cached: { at: number; facilities: AbdmFacility[] } | null = null;

    constructor(
        private readonly store: FacilityStore,
        private readonly now: () => number = Date.now,
    ) {}

    async all(): Promise<AbdmFacility[]> {
        if (!this.cached || this.now() - this.cached.at > CACHE_MS) {
            this.cached = { at: this.now(), facilities: await this.store.list() };
        }
        return this.cached.facilities;
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

    /** The hospital a Scan and Share profile is for, by the HIP id on the counter's QR code. */
    async byScanShareHipId(hipId: string | null | undefined): Promise<AbdmFacility | null> {
        if (!hipId) return null;
        return (await this.all()).find((f) => scanShareHipIdOf(f) === hipId) ?? null;
    }

    async save(hospitalId: number, input: FacilityInput, userId: string | null): Promise<AbdmFacility | null> {
        const hipId = String(input.hipId ?? "").trim().toUpperCase() || null;
        if (hipId && !HFR_ID.test(hipId)) throw new FacilityError("The HIP id must be the hospital's HFR facility id: IN followed by 10 digits.");
        const scanShareHipId = String(input.scanShareHipId ?? "").trim() || null;
        if (scanShareHipId && scanShareHipId.length > 50) throw new FacilityError("The Scan and Share HIP id is too long.");
        if (!hipId && !scanShareHipId) throw new FacilityError("Give the hospital's HFR facility id, or a Scan and Share HIP id.");
        const hipName = String(input.hipName ?? "").trim() || null;
        if (hipName && hipName.length > 100) throw new FacilityError("The facility name is too long.");
        await this.store.save(hospitalId, { ...input, hipId, hipName, scanShareHipId }, userId);
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
