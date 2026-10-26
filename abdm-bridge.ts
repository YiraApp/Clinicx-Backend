/**
 * Shows, or changes, where ABDM sends this client's callbacks (the bridge URL), using the ABDM
 * credentials in .env. Scan and Share needs the bridge URL to reach this backend: ABDM appends
 * /api/v3/hip/patient/share to it, and the M3 (HIU) callbacks /api/v3/hiu/... the same way.
 *
 *   npx tsx abdm-bridge.ts                     show the bridge URL and the services (HIP/HIU ids, types, endpoints)
 *   npx tsx abdm-bridge.ts set https://host    point the bridge at https://host
 *
 * Changing it redirects every callback for this ABDM client, including any other app's, so it
 * prints the current URL first and only changes it when asked to.
 */
import "dotenv/config";
import { abdmGatewayService } from "./src/services/Abdm/abdm-gateway.service.js";

const [command, url] = process.argv.slice(2);

const show = async () => {
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
};

try {
    await show();
    if (command === "set") {
        if (!url || !/^https:\/\/[^\s/]+/.test(url)) {
            throw new Error("Give the public https base URL of this backend, for example: npx tsx abdm-bridge.ts set https://clinicx-api-dev.azurewebsites.net");
        }
        await abdmGatewayService.call({ operation: "bridge/url", method: "PATCH", host: "gateway", path: "/api/hiecm/gateway/v3/bridge/url", body: { url: url.replace(/\/+$/, "") } });
        console.log(`Bridge URL set to ${url}. ABDM will post Scan and Share to ${url.replace(/\/+$/, "")}/api/v3/hip/patient/share`);
        await show();
    } else if (command) {
        throw new Error(`Unknown command "${command}". Use no argument to show, or "set <url>".`);
    }
} catch (error: any) {
    console.error(`Failed: ${error?.message}`);
    process.exitCode = 1;
}
