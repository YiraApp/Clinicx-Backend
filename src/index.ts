import "reflect-metadata";
process.env.TZ = "Asia/Kolkata";

import dotenv from "dotenv";
dotenv.config();

import app from "./app.js";
import { initializeDatabase } from "./config/database.js";
import { MigrationService } from "./services/Common/migration.service.js";
import { DietMigrationService } from "./services/Diet/diet-migration.service.js";

const port = process.env.PORT || 8080;

const startServer = async () => {
    try {
        await initializeDatabase();
        await MigrationService.ensureLogIndexes();
        await DietMigrationService.runMigrationsAndSeed();

        // Report at startup whether this server can send push notifications
        const { initFirebaseAdmin } = await import("./services/Notifications/firebase-admin.service.js");
        initFirebaseAdmin();

        // Start automated background appointment reminder scheduler (checks every 60s for 10-minute reminders)
        const { appointmentReminderService } = await import("./services/Appointments/appointment-reminder.service.js");
        appointmentReminderService.startScheduler(60);

        // Start automated background slot generator scheduler (syncs rolling slots for active hospitals)
        const { hospitalSettingsService } = await import("./services/Organizations/hospital-settings.service.js");
        hospitalSettingsService.startDailySlotScheduler(6);

        // Start automated push notification campaign scheduler (checks every 60s for scheduled & recurring notifications)
        const { pushCampaignService } = await import("./services/Notifications/push-campaign.service.js");
        pushCampaignService.startScheduler(60);

        // Start automated background document upload booking link scheduler (checks every 30s)
        const { medicalDocumentService } = await import("./services/Appointments/medical-document.service.js");
        medicalDocumentService.startBookingScheduler(30);

        // Start automated medication reminder pill alarm scheduler (checks every 60s in IST timezone)
        const { medicationReminderService } = await import("./services/Appointments/medication-reminder.service.js");
        medicationReminderService.startScheduler(60);

        // Start MedSense timeout checker (reads a report with Gemini if MedSense hasn't answered in time)
        const { medSenseService } = await import("./services/Appointments/medsense.service.js");
        medSenseService.startScheduler(60);

        // Start API log retention scheduler (deletes logs older than 3 months, runs at midnight IST)
        const { apiLogRetentionService } = await import("./services/Logs/apilog-retention.service.js");
        apiLogRetentionService.startScheduler();

        app.listen(Number(port), "0.0.0.0", () => {
            console.log(`Server is running on port ${port} (0.0.0.0)`);
        });

    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
};

startServer();