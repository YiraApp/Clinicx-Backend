/**
 * Imports the Indian Nutrient Databank (INDB) recipes into the master food list.
 *
 *   npm run import-indb-foods              add new INDB foods, refresh existing ones
 *   npm run import-indb-foods -- --dry-run show what would change, write nothing
 *   npm run import-indb-foods -- --remove  hide all INDB foods again
 *
 * Safe to run more than once: foods are matched on their INDB code, so a re-run
 * updates rows instead of duplicating them. Foods that came from anywhere else
 * (the starter list, an organization's own foods) are never touched.
 * "--remove" deactivates rather than deletes, because diet plans and templates
 * may already reference these rows.
 */
import { AppDataSource } from "../src/config/database.js";
import { indbFoods, INDB_SOURCE, INDB_VERSION } from "../src/services/Diet/data/indb-foods.js";
import dotenv from "dotenv";
dotenv.config();

const dryRun = process.argv.includes("--dry-run");
const remove = process.argv.includes("--remove");

const run = async () => {
    try {
        await AppDataSource.initialize();
        console.log("[INDB] Connected to database successfully.");

        const table = await AppDataSource.query(`SELECT OBJECT_ID('DietFoodItems') AS id`);
        if (!table[0]?.id) {
            throw new Error("DietFoodItems does not exist yet. Start the backend once so it creates the diet tables.");
        }

        const hasColumns = await AppDataSource.query(`SELECT COL_LENGTH('DietFoodItems', 'SourceCode') AS len`);
        const columnsExist = hasColumns[0]?.len !== null && hasColumns[0]?.len !== undefined;

        // Where each food came from, so imported rows can be told apart and refreshed.
        if (!columnsExist && !dryRun) {
            await AppDataSource.query(`ALTER TABLE DietFoodItems ADD Source NVARCHAR(50) NULL, SourceCode NVARCHAR(50) NULL`);
            await AppDataSource.query(`
                CREATE INDEX IX_DietFoodItems_Source ON DietFoodItems (Source, SourceCode) WHERE SourceCode IS NOT NULL
            `);
            console.log("[INDB] Added Source and SourceCode columns to DietFoodItems.");
        }

        const existing: Array<{ SourceCode: string; IsActive: boolean }> = columnsExist
            ? await AppDataSource.query(
                `SELECT SourceCode, IsActive FROM DietFoodItems WHERE Source = @0 AND OrganizationId IS NULL`,
                [INDB_SOURCE]
            )
            : [];
        const existingCodes = new Set(existing.map(row => row.SourceCode));

        if (remove) {
            const active = existing.filter(row => row.IsActive).length;
            console.log(`[INDB] ${active} active INDB foods will be hidden.`);
            if (!dryRun && columnsExist) {
                await AppDataSource.query(
                    `UPDATE DietFoodItems SET IsActive = 0 WHERE Source = @0 AND OrganizationId IS NULL`,
                    [INDB_SOURCE]
                );
                console.log("[INDB] Done. Run the import again to bring them back.");
            }
            await AppDataSource.destroy();
            process.exit(0);
        }

        const fileCodes = new Set(indbFoods.map(food => food.code));
        const toInsert = indbFoods.filter(food => !existingCodes.has(food.code));
        const toUpdate = indbFoods.filter(food => existingCodes.has(food.code));
        // Foods a newer data file no longer includes (for example, dropped by a quality check).
        const stale = [...existingCodes].filter(code => !fileCodes.has(code));

        const otherFoods = await AppDataSource.query(`
            SELECT COUNT(*) AS count FROM DietFoodItems
            WHERE OrganizationId IS NULL AND IsActive = 1 ${columnsExist ? "AND Source IS NULL" : ""}
        `);

        console.log(`[INDB] INDB ${INDB_VERSION}: ${indbFoods.length} foods in the data file.`);
        console.log(`[INDB] To add: ${toInsert.length}. To refresh: ${toUpdate.length}. To hide as no longer included: ${stale.length}.`);
        console.log(`[INDB] ${otherFoods[0]?.count ?? 0} existing master foods from other sources are left as they are.`);

        if (dryRun) {
            console.log("[INDB] Dry run: nothing was written.");
            await AppDataSource.destroy();
            process.exit(0);
        }

        await AppDataSource.transaction(async manager => {
            for (const food of indbFoods) {
                const params = [
                    INDB_SOURCE, food.code, food.name, food.category, food.foodType, food.servingSize,
                    food.calServ, food.p, food.c, food.f, food.fib, food.sugar, food.sodium
                ];

                if (existingCodes.has(food.code)) {
                    await manager.query(`
                        UPDATE DietFoodItems SET
                            Name = @2, Category = @3, FoodType = @4, ServingSize = @5,
                            CaloriesPerServing = @6, ProteinG = @7, CarbsG = @8, FatG = @9,
                            FiberG = @10, SugarG = @11, SodiumMg = @12, IsActive = 1
                        WHERE Source = @0 AND SourceCode = @1 AND OrganizationId IS NULL
                    `, params);
                } else {
                    // INDB's per-100g values are per 100 g of raw ingredients, so CaloriesPer100g stays 0.
                    await manager.query(`
                        INSERT INTO DietFoodItems (
                            Source, SourceCode, Name, Category, FoodType, ServingSize,
                            CaloriesPer100g, CaloriesPerServing, ProteinG, CarbsG, FatG,
                            FiberG, SugarG, SodiumMg, IsActive, OrganizationId, CreatedAt
                        ) VALUES (
                            @0, @1, @2, @3, @4, @5,
                            0, @6, @7, @8, @9,
                            @10, @11, @12, 1, NULL, GETDATE()
                        )
                    `, params);
                }
            }

            for (const code of stale) {
                await manager.query(
                    `UPDATE DietFoodItems SET IsActive = 0 WHERE Source = @0 AND SourceCode = @1 AND OrganizationId IS NULL`,
                    [INDB_SOURCE, code]
                );
            }
        });

        const total = await AppDataSource.query(
            `SELECT COUNT(*) AS count FROM DietFoodItems WHERE Source = @0 AND IsActive = 1`,
            [INDB_SOURCE]
        );
        console.log(`[INDB] Import completed. ${total[0]?.count ?? 0} INDB foods are now active.`);

        await AppDataSource.destroy();
        process.exit(0);
    } catch (e) {
        console.error("[INDB ERROR]", e);
        process.exit(1);
    }
};

run();
