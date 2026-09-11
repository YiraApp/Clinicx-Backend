import { AppDataSource } from "../src/config/database.js";
import dotenv from "dotenv";
dotenv.config();

const run = async () => {
    try {
        await AppDataSource.initialize();
        console.log("[MIGRATION] Connected to database successfully.");

        const query = `
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('PatientMedicalRecord') AND name = 'SpO2')
        BEGIN
            ALTER TABLE PatientMedicalRecord ADD SpO2 NVARCHAR(50) NULL;
            PRINT 'Added SpO2 column to PatientMedicalRecord';
        END
        ELSE
        BEGIN
            PRINT 'SpO2 column already exists in PatientMedicalRecord';
        END
        `;

        await AppDataSource.query(query);
        console.log("[MIGRATION] SpO2 migration completed successfully.");

        const cols = await AppDataSource.query(`
            SELECT COLUMN_NAME, DATA_TYPE 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'PatientMedicalRecord' AND COLUMN_NAME = 'SpO2';
        `);
        console.log("[MIGRATION] Verified column in PatientMedicalRecord:", cols);

        await AppDataSource.destroy();
        process.exit(0);
    } catch (e) {
        console.error("[MIGRATION ERROR]", e);
        process.exit(1);
    }
};

run();
