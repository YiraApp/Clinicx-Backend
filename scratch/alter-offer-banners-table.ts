import { AppDataSource } from "../src/config/database.js";
import dotenv from "dotenv";
dotenv.config();

const run = async () => {
    try {
        await AppDataSource.initialize();
        console.log("[MIGRATION] Database connected successfully");

        const queries = [
            `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('OfferBanners') AND name = 'ShowTitle')
             ALTER TABLE OfferBanners ADD ShowTitle BIT NOT NULL DEFAULT 1;`,

            `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('OfferBanners') AND name = 'ShowDescription')
             ALTER TABLE OfferBanners ADD ShowDescription BIT NOT NULL DEFAULT 1;`,

            `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('OfferBanners') AND name = 'ShowOfferTag')
             ALTER TABLE OfferBanners ADD ShowOfferTag BIT NOT NULL DEFAULT 1;`,

            `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('OfferBanners') AND name = 'OfferTag')
             ALTER TABLE OfferBanners ADD OfferTag NVARCHAR(100) NULL DEFAULT 'SPECIAL OFFER';`,

            `UPDATE OfferBanners 
             SET ShowTitle = 1, ShowDescription = 1, ShowOfferTag = 1, OfferTag = 'SPECIAL OFFER'
             WHERE OfferTag IS NULL;`,
        ];

        for (const q of queries) {
            await AppDataSource.query(q);
        }

        console.log("[MIGRATION] Columns added/updated successfully.");

        const rows = await AppDataSource.query("SELECT TOP 3 Id, Title, ShowTitle, ShowDescription, ShowOfferTag, OfferTag FROM OfferBanners;");
        console.log("[MIGRATION] Sample data:", rows);

        await AppDataSource.destroy();
        process.exit(0);
    } catch (e) {
        console.error("[MIGRATION ERROR]", e);
        process.exit(1);
    }
};

run();
