import { AppDataSource } from "../src/config/database.js";
import { mobileDashboardService } from "../src/MobileApi/v1/services/provider/mobile-dashboard.service.js";

async function test() {
    await AppDataSource.initialize();
    const overview = await mobileDashboardService.getPatientOverview(
        "C6D7853D-CA74-4E4E-AC2F-392450BEAAEC",
        1,
        19
    );
    console.log("Overview response keys:", Object.keys(overview));
    console.log("Overview hospital:", JSON.stringify(overview.hospital, null, 2));

    await AppDataSource.destroy();
}

test().catch(console.error);
