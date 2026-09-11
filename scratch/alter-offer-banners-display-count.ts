import { AppDataSource } from "../src/config/database.js";
import dotenv from "dotenv";
dotenv.config();

const run = async () => {
    try {
        await AppDataSource.initialize();
        console.log("[MIGRATION] Connected to database successfully.");

        const query = `
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('OfferBanners') AND name = 'MaxDisplayCount')
        BEGIN
            ALTER TABLE OfferBanners ADD MaxDisplayCount INT NULL DEFAULT 0;
            PRINT 'Added MaxDisplayCount column to OfferBanners';
        END
        ELSE
        BEGIN
            PRINT 'MaxDisplayCount column already exists in OfferBanners';
        END
        `;

        await AppDataSource.query(query);
        console.log("[MIGRATION] Migration completed successfully.");

        const cols = await AppDataSource.query(`
            SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, COLUMN_DEFAULT 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'OfferBanners';
        `);
        console.log("[MIGRATION] Current columns in OfferBanners:", cols.map((c: any) => c.COLUMN_NAME));

        await AppDataSource.destroy();
        process.exit(0);
    } catch (e) {
        console.error("[MIGRATION ERROR]", e);
        process.exit(1);
    }
};

run();
