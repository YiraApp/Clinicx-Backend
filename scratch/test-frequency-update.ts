import { AppDataSource } from "../src/config/database.js";
import { offerBannerService } from "../src/services/Offers/offer-banner.service.js";
import dotenv from "dotenv";
dotenv.config();

const run = async () => {
    try {
        await AppDataSource.initialize();
        const popup = await offerBannerService.getActivePopupAd();
        if (popup) {
            await offerBannerService.updateOffer(popup.id, {
                maxDisplayCount: 5,
                startDate: new Date(),
                endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
            });
        }
        const updated = await offerBannerService.getActivePopupAd();
        console.log("[TEST] Updated popup ad:", JSON.stringify(updated, null, 2));
        await AppDataSource.destroy();
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
};

run();
