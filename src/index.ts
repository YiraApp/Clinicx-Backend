import "reflect-metadata";
process.env.TZ = "Asia/Kolkata";

import dotenv from "dotenv";
dotenv.config();

import app from "./app.js";
import { initializeDatabase } from "./config/database.js";
import { MigrationService } from "./services/Common/migration.service.js";

const port = process.env.PORT || 8080;

const startServer = async () => {
    try {
        await initializeDatabase();
        await MigrationService.ensureLogIndexes();

        // Start automated background appointment reminder scheduler (checks every 60s for 10-minute reminders)
        const { appointmentReminderService } = await import("./services/Appointments/appointment-reminder.service.js");
        appointmentReminderService.startScheduler(60);

        app.listen(Number(port), "0.0.0.0", () => {
            console.log(`Server is running on port ${port} (0.0.0.0)`);
        });

    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
};

startServer();