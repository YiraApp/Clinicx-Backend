import { abdmFacilities, abdmSettings, type AbdmFacilityDirectory, type Hip, type AbdmSettings } from "./abdm-facilities.service.js";
import { AbdmApiError, abdmGatewayService, type AbdmGatewayService } from "./abdm-gateway.service.js";

/**
 * Whether ABDM can reach this deployment as an HIP, read from the bridge registry rather than
 * assumed: the bridge is active and calls back on this deployment's URL (AbdmSettings), and each
 * hospital's facility (AbdmFacilities) is a service on it that ABDM itself accepts. Every M2
 * journey depends on all three.
 */

export interface BridgeService {
    id: string;
    name: string | null;
    types: string[];
    active: boolean;
}

export interface HipReadiness {
    hipId: string;
    /** ClinicX hospital the HIP shares records for, and its name in the clinic database. */
    hospitalId: number;
    hospitalName: string | null;
    onBridge: boolean;
    isHip: boolean;
    active: boolean;
    /** ABDM's refusal when it would not read the service id, passed on unchanged. */
    refusal: { code: string | null; message: string; requestId: string | null } | null;
}

export interface BridgeReadiness {
    ready: boolean;
    /** One line per thing that stops M2 working, in the order to fix them. */
    problems: string[];
    bridge: { id: string | null; name: string | null; url: string | null; active: boolean; blocklisted: boolean };
    expectedUrl: string | null;
    /** One per hospital set up as an ABDM facility. */
    hips: HipReadiness[];
    services: BridgeService[];
}

export interface HipHospitalLookup {
    findHospitalName(hospitalId: number): Promise<string | null>;
}

/** A bridge URL this system won't send to ABDM, with the reason. */
export class BridgeUrlError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BridgeUrlError";
    }
}

/**
 * ABDM appends /api/v3/... to the bridge URL, and this API serves those at its root, so the
 * bridge URL is an https origin with no path.
 */
export const checkBridgeUrl = (value: unknown): string => {
    let url: URL;
    try {
        url = new URL(String(value ?? "").trim());
    } catch {
        throw new BridgeUrlError("The bridge URL isn't a valid URL.");
    }
    if (url.protocol !== "https:") throw new BridgeUrlError("The bridge URL must use https.");
    if (url.pathname !== "/" || url.search || url.hash) {
        throw new BridgeUrlError(`The bridge URL must be the API's origin with no path, such as ${url.origin}: ABDM adds /api/v3/... itself.`);
    }
    return url.origin;
};

const sameUrl = (a: string, b: string): boolean =>
    a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

const readServices = (body: any): BridgeService[] =>
    (Array.isArray(body?.services) ? body.services : []).map((s: any) => ({
        id: String(s?.id ?? ""),
        name: s?.name ? String(s.name) : null,
        types: Array.isArray(s?.types) ? s.types.map(String) : [],
        active: s?.active === true,
    }));

export class AbdmBridgeService {
    constructor(
        private readonly hospitals: HipHospitalLookup,
        private readonly gateway: AbdmGatewayService = abdmGatewayService,
        private readonly facilities: Pick<AbdmFacilityDirectory, "hips"> = abdmFacilities,
        private readonly settings: Pick<AbdmSettings, "bridgeUrl" | "setBridgeUrl"> = abdmSettings,
    ) {}

    async checkReadiness(): Promise<BridgeReadiness> {
        const problems: string[] = [];

        const registry = await this.gateway.call({
            operation: "gateway/v3/bridge-services",
            host: "gateway",
            method: "GET",
            path: "/api/hiecm/gateway/v3/bridge-services",
        });

        const bridge = {
            id: registry?.bridge?.id ? String(registry.bridge.id) : null,
            name: registry?.bridge?.name ? String(registry.bridge.name) : null,
            url: registry?.bridge?.url ? String(registry.bridge.url) : null,
            active: registry?.bridge?.active === true,
            blocklisted: registry?.bridge?.blocklisted === true,
        };
        const services = readServices(registry);

        if (!bridge.active) problems.push("ABDM reports this bridge as inactive.");
        if (bridge.blocklisted) problems.push("ABDM reports this bridge as blocklisted.");

        const expectedUrl = (await this.settings.bridgeUrl()) || null;
        if (!expectedUrl) {
            problems.push(`No bridge URL is saved for this deployment, so it can't be confirmed that ABDM calls back here. ABDM currently calls ${bridge.url ?? "no URL"}.`);
        } else if (!bridge.url || !sameUrl(bridge.url, expectedUrl)) {
            problems.push(`ABDM calls back on ${bridge.url ?? "no URL"}, not on this deployment (${expectedUrl}). Update the bridge URL.`);
        }

        const facilities = await this.facilities.hips();
        if (!facilities.length) problems.push("No hospital is set up as an ABDM facility yet: save its HFR facility id first.");
        const hips: HipReadiness[] = [];
        for (const facility of facilities) hips.push(await this.checkHip(facility, services, problems));
        return { ready: problems.length === 0, problems, bridge, expectedUrl, hips, services };
    }

    /**
     * Points the bridge, and with it every facility's callbacks, at [url]. Done when the
     * registry reads back the new URL, not when the PATCH answers 202, so the readiness read
     * after it is the result.
     */
    async updateBridgeUrl(url: unknown): Promise<BridgeReadiness> {
        const origin = checkBridgeUrl(url);
        await this.gateway.call({
            operation: "gateway/v3/bridge/url",
            host: "gateway",
            method: "PATCH",
            path: "/api/hiecm/gateway/v3/bridge/url",
            body: { url: origin },
        });
        await this.settings.setBridgeUrl(origin);
        const readiness = await this.checkReadiness();
        if (!readiness.bridge.url || !sameUrl(readiness.bridge.url, origin)) {
            readiness.problems.unshift(`ABDM accepted the update but still reports ${readiness.bridge.url ?? "no URL"} instead of ${origin}. Check again in a minute.`);
            readiness.ready = false;
        }
        return readiness;
    }

    private async checkHip(facility: Hip, services: BridgeService[], problems: string[]): Promise<HipReadiness> {
        const { id: hipId, hospitalId } = facility;
        const hospitalName = await this.hospitals.findHospitalName(hospitalId);
        if (!hospitalName) {
            problems.push(`${hipId} is saved for hospital ${hospitalId}, but no such hospital exists in the clinic database.`);
        }

        const listed = services.find((s) => s.id === hipId);
        const hip: HipReadiness = {
            hipId,
            hospitalId,
            hospitalName,
            onBridge: Boolean(listed),
            isHip: Boolean(listed?.types.includes("HIP")),
            active: Boolean(listed?.active),
            refusal: null,
        };

        // The registry listing is not ABDM's verdict on the id. ABDM's sandbox procedure
        // (shared.sandbox.sandbox-to-hip-or-hiu-id) gives this lookup as the proof of a working
        // HIP id: the facility comes back active with isHip true. An id that fails it is refused
        // on M2 calls as ABDM-1035 once the patient checks pass.
        try {
            const details = await this.gateway.call({
                operation: "gateway/v3/bridge-service/serviceId",
                host: "gateway",
                method: "GET",
                path: `/api/hiecm/gateway/v3/bridge-service/serviceId/${encodeURIComponent(hipId)}`,
            });
            hip.isHip = details?.isHip === true;
            hip.active = details?.active === true;
        } catch (error) {
            if (!(error instanceof AbdmApiError) || error.kind !== "rejected") throw error;
            hip.refusal = { code: error.code, message: error.message, requestId: error.requestId };
            problems.push(`ABDM's service lookup refuses the HIP id ${hipId}: ${error.message}${error.code ? ` (${error.code})` : ""}. M2 needs the facility's HFR id (12 characters, starting with IN) linked to this bridge as HIP.`);
            return hip;
        }

        if (!hip.onBridge) problems.push(`${hipId} is not a service on this bridge.`);
        else if (!hip.isHip) problems.push(`${hipId} is on this bridge but not registered as an HIP.`);
        else if (!hip.active) problems.push(`${hipId} is registered as an HIP but inactive.`);
        return hip;
    }
}
