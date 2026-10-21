/**
 * One-time script to populate food images for all DietFoodItems.
 *
 * Prerequisites:
 *   1. Set PEXELS_API_KEY in your .env (free at https://www.pexels.com/api/)
 *   2. Ensure AZURE_STORAGE_CONNECTION_STRING is set
 *
 * Usage:
 *   npx tsx populate-food-images.ts
 */

import dotenv from "dotenv";
dotenv.config();

import { AppDataSource } from "./src/config/database.js";
import { DietFoodImagesService } from "./src/services/Diet/diet-food-images.service.js";

async function main() {
    console.log("🚀 Connecting to database...");
    await AppDataSource.initialize();
    console.log("✅ Database connected.\n");

    const result = await DietFoodImagesService.populateAllFoodImages();

    console.log("\n📊 Summary:");
    console.log(`   Updated: ${result.updated}`);
    console.log(`   Skipped: ${result.skipped}`);
    console.log(`   Failed:  ${result.failed}`);

    await AppDataSource.destroy();
    process.exit(0);
}

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
