import { AppDataSource } from "../../config/database.js";
import { blobService } from "../Common/blob.service.js";

const PEXELS_API_KEY = process.env.PEXELS_API_KEY || "";

interface PexelsPhoto {
    id: number;
    src: { medium: string; small: string };
}

/**
 * Populates ImageUrl for all DietFoodItems that don't have one.
 * Uses the Pexels API to search for a relevant photo, downloads it,
 * uploads to Azure Blob Storage, and updates the DB record.
 *
 * Requires PEXELS_API_KEY in env (free at https://www.pexels.com/api/).
 */
export class DietFoodImagesService {

    static async populateAllFoodImages() {
        if (!PEXELS_API_KEY) {
            console.error("❌ [FoodImages] PEXELS_API_KEY not set. Get a free key at https://www.pexels.com/api/");
            return { updated: 0, failed: 0, skipped: 0 };
        }

        const foods: Array<{ Id: number; Name: string; Category: string }> = await AppDataSource.query(`
            SELECT Id, Name, Category FROM DietFoodItems
            WHERE IsActive = 1 AND (ImageUrl IS NULL OR ImageUrl = '')
            ORDER BY Id
        `);

        console.log(`🖼️  [FoodImages] Found ${foods.length} food items without images.`);

        let updated = 0;
        let failed = 0;
        let skipped = 0;

        for (const food of foods) {
            try {
                const query = buildSearchQuery(food.Name, food.Category);
                const imageUrl = await searchAndUpload(food.Id, query);

                if (imageUrl) {
                    await AppDataSource.query(
                        `UPDATE DietFoodItems SET ImageUrl = @0 WHERE Id = @1`,
                        [imageUrl, food.Id]
                    );
                    updated++;
                    console.log(`  ✅ [${updated}/${foods.length}] ${food.Name} → image saved`);
                } else {
                    skipped++;
                    console.log(`  ⏭️  [${skipped}] ${food.Name} → no image found for "${query}"`);
                }

                // Pexels rate limit: 200 req/hour → ~3 req/sec is safe
                await sleep(400);
            } catch (err: any) {
                failed++;
                console.error(`  ❌ ${food.Name}: ${err.message}`);
                await sleep(1000);
            }
        }

        console.log(`🖼️  [FoodImages] Done. Updated: ${updated}, Skipped: ${skipped}, Failed: ${failed}`);
        return { updated, failed, skipped };
    }
}

/**
 * Builds a search query optimized for finding Indian food photos.
 * Strips parenthetical details and appends "Indian food" for better results.
 */
function buildSearchQuery(name: string, category: string): string {
    // Remove parenthetical content: "Idli (2 pieces)" → "Idli"
    let query = name.replace(/\s*\(.*?\)\s*/g, " ").trim();

    // Remove quantity prefixes: "2 Boiled Eggs" → "Boiled Eggs"
    query = query.replace(/^\d+\s+/, "");

    // Remove trailing serving info
    query = query.replace(/,?\s*(with|no|light|homestyle|unsweetened|plain).*$/i, "").trim();

    // For very short names or generic ones, add context
    if (query.split(" ").length <= 1) {
        query += " Indian food";
    } else if (!query.toLowerCase().includes("indian")) {
        query += " Indian dish";
    }

    return query;
}

async function searchAndUpload(foodId: number, query: string): Promise<string | null> {
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=square`;

    const response = await fetch(searchUrl, {
        headers: { Authorization: PEXELS_API_KEY }
    });

    if (!response.ok) {
        if (response.status === 429) {
            console.warn("  ⚠️  Pexels rate limit hit, waiting 60s...");
            await sleep(60000);
            return searchAndUpload(foodId, query);
        }
        throw new Error(`Pexels API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { photos: PexelsPhoto[] };

    if (!data.photos || data.photos.length === 0) {
        // Fallback: try just the category
        return tryFallbackSearch(foodId, query.split(" ")[0]);
    }

    const photo = data.photos[0];
    const imageSourceUrl = photo.src.small; // 130x130 — fast, small file size

    // Download and upload to Azure Blob
    const result = await blobService.uploadFromUrl(
        imageSourceUrl,
        "diet-foods",
        "food-images",
        `food_${foodId}.jpg`
    );

    return result.fileUrl;
}

async function tryFallbackSearch(foodId: number, keyword: string): Promise<string | null> {
    const fallbackUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword + " food")}&per_page=1&orientation=square`;

    const response = await fetch(fallbackUrl, {
        headers: { Authorization: PEXELS_API_KEY }
    });

    if (!response.ok) return null;

    const data = await response.json() as { photos: PexelsPhoto[] };
    if (!data.photos || data.photos.length === 0) return null;

    const photo = data.photos[0];
    const result = await blobService.uploadFromUrl(
        photo.src.small,
        "diet-foods",
        "food-images",
        `food_${foodId}.jpg`
    );

    return result.fileUrl;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
