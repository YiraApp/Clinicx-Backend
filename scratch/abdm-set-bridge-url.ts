/**
 * Points this ABDM bridge's callbacks at a URL, through the backend's own updateBridgeUrl: PATCH the
 * gateway, save the setting, then read ABDM's registry back. Prints the readiness, never credentials.
 *
 *   npx tsx --env-file=.env scratch/abdm-set-bridge-url.ts https://<origin>
 *
 * Every ABDM callback for this bridge (all its facilities) goes to that URL afterwards, so point it
 * back at QA when a local test is done: https://clinicx-api-qa.azurewebsites.net
 */
import { AppDataSource } from "../src/config/database.js";
import { abhaRepository } from "../src/repositories/Abdm/abha.repository.js";
import { AbdmBridgeService } from "../src/services/Abdm/abdm-bridge.service.js";

const url = process.argv[2];
if (!url) {
    console.error("Usage: npx tsx --env-file=.env scratch/abdm-set-bridge-url.ts https://<origin>");
    process.exit(1);
}

await AppDataSource.initialize();
try {
    const r = await new AbdmBridgeService(abhaRepository).updateBridgeUrl(url);
    console.log(JSON.stringify({
        bridgeUrl: r.bridge.url,
        active: r.bridge.active,
        ready: r.ready,
        problems: r.problems,
        hips: r.hips.map((h) => ({ hipId: h.hipId, onBridge: h.onBridge, isHip: h.isHip, active: h.active })),
    }, null, 1));
} finally {
    await AppDataSource.destroy();
}
process.exit(0);
