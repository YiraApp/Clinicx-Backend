import { AppDataSource } from "../src/config/database.ts";

async function main() {
    try {
        console.log("Connecting to database...");
        await AppDataSource.initialize();
        console.log("Database connected successfully.");

        console.log("Dropping column AppointmentId...");
        try {
            await AppDataSource.query("ALTER TABLE Payments DROP COLUMN AppointmentId");
            console.log("Successfully dropped column AppointmentId.");
        } catch (dropErr) {
            console.log("Drop column failed (might not exist yet):", dropErr.message);
        }

        console.log("Adding column AppointmentId as INT...");
        await AppDataSource.query("ALTER TABLE Payments ADD AppointmentId INT NULL");
        console.log("Successfully added column AppointmentId as INT.");


        console.log("Database migration complete.");
    } catch (err) {
        console.error("Migration error:", err);
    } finally {
        if (AppDataSource.isInitialized) {
            await AppDataSource.destroy();
        }
        process.exit(0);
    }
}

main();
