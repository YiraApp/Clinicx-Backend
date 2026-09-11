import { AppDataSource } from "../src/config/database.js";

async function run() {
    await AppDataSource.initialize();
    console.log("Database initialized.");

    const columns = await AppDataSource.query(`
        SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = 'Hospitals'
    `);
    console.log("Hospitals columns:", columns.map((c: any) => c.COLUMN_NAME).join(", "));

    const orgColumns = await AppDataSource.query(`
        SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = 'Organizations'
    `);
    console.log("Organizations columns:", orgColumns.map((c: any) => c.COLUMN_NAME).join(", "));

    const hospitals = await AppDataSource.query(`
        SELECT TOP 5 * FROM Hospitals
    `);
    console.log("Sample hospitals in DB:", JSON.stringify(hospitals, null, 2));

    const orgs = await AppDataSource.query(`
        SELECT TOP 5 * FROM Organizations
    `);
    console.log("Sample orgs in DB:", JSON.stringify(orgs, null, 2));

    await AppDataSource.destroy();
}

run().catch(console.error);
