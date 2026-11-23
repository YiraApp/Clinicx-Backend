/**
 * Shows, or changes, where ABDM sends this client's callbacks (the bridge URL), using the ABDM
 * credentials in .env. Scan and Share needs the bridge URL to reach this backend: ABDM appends
 * /api/v3/hip/patient/share to it, and the M3 (HIU) callbacks /api/v3/hiu/... the same way.
 *
 *   npx tsx abdm-bridge.ts                     show the bridge URL and the services (HIP/HIU ids, types, endpoints)
 *   npx tsx abdm-bridge.ts set https://host    point the bridge at https://host
 *   npx tsx abdm-bridge.ts link IN0000000000 "Facility Name" "HIP Name" [--hiu] [--send]
 *                                              add an HFR facility to this bridge as a HIP (and an HIU
 *                                              with --hiu): ABDM's M4 call MutipleHRPAddUpdateServices on
 *                                              the facility registry. Prints the request; sends it only
 *                                              with --send, then shows the bridge and the service again.
 *
 * Changing it redirects every callback for this ABDM client, including any other app's, so it
 * prints the current URL first and only changes it when asked to.
 */
import "dotenv/config";
import { abdmGatewayService } from "./src/services/Abdm/abdm-gateway.service.js";

const [command, url] = process.argv.slice(2);

/** ABDM's sandbox facility registry (M4), where a facility is linked to a bridge. */
const FACILITY_REGISTRY = (process.env.ABDM_FACILITY_REGISTRY_URL || "https://apihspsbx.abdm.gov.in/v4/int").replace(/\/+$/, "");

/** ABDM's rules for MutipleHRPAddUpdateServices: the request is refused or mislinked otherwise. */
const checkFacility = (facilityId: string, facilityName: string, hipName: string): void => {
    if (!/^IN\d{10}$/.test(facilityId)) throw new Error(`The facility id must be the HFR id: "IN" and 10 digits (12 characters), not "${facilityId}".`);
    if (!/^[A-Za-z0-9][A-Za-z0-9\-_.(),/]*( [A-Za-z0-9\-_.(),/]+)*$/.test(facilityName)) {
        throw new Error("The facility name may use letters, digits and - _ . ( ) , / only, start with a letter or digit, and have one space between words.");
    }
    if (!hipName || hipName.length > 15 || /[%$*#@(~&!]/.test(hipName)) {
        throw new Error("The HIP name (shown to patients in the ABHA/PHR app) must be 15 characters or fewer, without % $ * # @ ( ~ & !.");
    }
};

const showService = async (serviceId: string) => {
    const service = await abdmGatewayService.call<any>({ operation: "bridge-service/serviceId", method: "GET", host: "gateway", path: `/api/hiecm/gateway/v3/bridge-service/serviceId/${encodeURIComponent(serviceId)}` });
    console.log(`Service ${serviceId}: isHip=${service?.isHip ?? "-"} isHiu=${service?.isHiu ?? "-"} active=${service?.active ?? "-"}`);
};

const show = async (): Promise<any> => {
    const result = await abdmGatewayService.call<any>({ operation: "bridge-services", method: "GET", host: "gateway", path: "/api/hiecm/gateway/v3/bridge-services" });
    console.log(`Bridge ${result?.bridge?.id} (${result?.bridge?.name}): ${result?.bridge?.url} ${result?.bridge?.active ? "active" : "inactive"}`);
    for (const service of result?.services ?? []) {
        console.log(`  service ${service.id} "${service.name}" types=${(service.types ?? []).join(",")} ${service.active ? "active" : "inactive"}`);
        // The per-role endpoints registered for the service (hipEndpoints, hiuEndpoints, ...), if any.
        const endpoints = service.endpoints && typeof service.endpoints === "object" ? service.endpoints : {};
        const groups = Object.entries(endpoints).filter(([, list]) => Array.isArray(list) && list.length > 0);
        if (groups.length === 0) console.log("    endpoints: none registered");
        for (const [group, list] of groups as [string, any[]][]) {
            for (const endpoint of list) {
                console.log(`    ${group}: use=${endpoint?.use ?? "-"} ${endpoint?.connectionType ?? "-"} ${endpoint?.address ?? "-"}`);
            }
        }
    }
    return result;
};

try {
    const bridge = await show();
    if (command === "link") {
        const args = process.argv.slice(3).filter((arg) => !arg.startsWith("--"));
        const [facilityId = "", facilityName = "", hipName = ""] = args.map((arg) => arg.trim());
        checkFacility(facilityId, facilityName, hipName);
        const bridgeId = String(bridge?.bridge?.id ?? "");
        if (!bridgeId) throw new Error("ABDM did not say which bridge this client has.");
        const types = process.argv.includes("--hiu") ? ["HIP", "HIU"] : ["HIP"];
        const body = { facilityId, facilityName, HRP: types.map((type) => ({ bridgeId, hipName, type, active: true })) };
        console.log(`\nPOST ${FACILITY_REGISTRY}/v1/bridges/MutipleHRPAddUpdateServices\n${JSON.stringify(body, null, 2)}`);
        if (!process.argv.includes("--send")) {
            console.log("\nNot sent. Add --send to link the facility to this bridge.");
        } else {
            const response = await fetch(`${FACILITY_REGISTRY}/v1/bridges/MutipleHRPAddUpdateServices`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${await abdmGatewayService.getAccessToken()}` },
                body: JSON.stringify(body),
            });
            const text = (await response.text()).slice(0, 500);
            console.log(`ABDM answered ${response.status}: ${text || "(empty)"}`);
            if (!response.ok) throw new Error(`The facility was not linked (HTTP ${response.status}).`);
            await show();
            await showService(facilityId);
        }
    } else if (command === "set") {
        if (!url || !/^https:\/\/[^\s/]+/.test(url)) {
            throw new Error("Give the public https base URL of this backend, for example: npx tsx abdm-bridge.ts set https://clinicx-api-dev.azurewebsites.net");
        }
        await abdmGatewayService.call({ operation: "bridge/url", method: "PATCH", host: "gateway", path: "/api/hiecm/gateway/v3/bridge/url", body: { url: url.replace(/\/+$/, "") } });
        console.log(`Bridge URL set to ${url}. ABDM will post Scan and Share to ${url.replace(/\/+$/, "")}/api/v3/hip/patient/share`);
        await show();
    } else if (command) {
        throw new Error(`Unknown command "${command}". Use no argument to show, "set <url>", or "link <facilityId> <facilityName> <hipName>".`);
    }
} catch (error: any) {
    console.error(`Failed: ${error?.message}`);
    process.exitCode = 1;
}
