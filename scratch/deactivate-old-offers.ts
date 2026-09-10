import { AppDataSource } from "../src/config/database.js";
import { offerBannerRepository } from "../src/repositories/Offers/offer-banner.repository.js";
import dotenv from "dotenv";

dotenv.config();

const run = async () => {
    try {
        await AppDataSource.initialize();
        console.log("[CLEANUP] Database connected.");
        await offerBannerRepository.update(9, { IsActive: false });
        await offerBannerRepository.update(10, { IsActive: false });
        console.log("[CLEANUP] Deactivated old dummy offers 9 and 10.");
        await AppDataSource.destroy();
        process.exit(0);
    } catch (e) {
        console.error("[CLEANUP ERROR]", e);
        process.exit(1);
    }
};

run();
