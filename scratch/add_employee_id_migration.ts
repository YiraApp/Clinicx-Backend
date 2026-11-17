import { AppDataSource } from "../src/config/database.js";

async function run() {
    try {
        await AppDataSource.initialize();
        console.log("Database connected successfully.");

        // Check if EmployeeId column exists in Users table
        const userCols = await AppDataSource.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'Users' AND COLUMN_NAME = 'EmployeeId'
        `);

        if (userCols.length === 0) {
            console.log("Adding EmployeeId to Users table...");
            await AppDataSource.query(`
                ALTER TABLE Users 
                ADD EmployeeId NVARCHAR(100) NULL
            `);
            console.log("EmployeeId column added to Users table successfully.");
        } else {
            console.log("EmployeeId column already exists in Users table.");
        }

        // Check if EmployeeId column exists in PatientRegistrations table
        const regCols = await AppDataSource.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'PatientRegistrations' AND COLUMN_NAME = 'EmployeeId'
        `);

        if (regCols.length === 0) {
            console.log("Adding EmployeeId to PatientRegistrations table...");
            await AppDataSource.query(`
                ALTER TABLE PatientRegistrations 
                ADD EmployeeId NVARCHAR(100) NULL
            `);
            console.log("EmployeeId column added to PatientRegistrations table successfully.");
        } else {
            console.log("EmployeeId column already exists in PatientRegistrations table.");
        }

        process.exit(0);
    } catch (error) {
        console.error("Migration failed:", error);
        process.exit(1);
    }
}

run();
