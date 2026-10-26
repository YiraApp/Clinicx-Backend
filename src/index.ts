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
        await MigrationService.ensureAbdmSchema();
        await MigrationService.ensureAbdmHiuSchema();
        await DietMigrationService.runMigrationsAndSeed();

        // ABDM calls answered on a callback are recorded before they are sent
        const { abdmGatewayService } = await import("./services/Abdm/abdm-gateway.service.js");
        const { abdmExchangeRepository } = await import("./repositories/Abdm/abdm-exchange.repository.js");
        abdmGatewayService.setExchangeRecorder(abdmExchangeRepository);

        // ABDM M2: link new care contexts and announce new records on a schedule, for each hospital
        // whose facility has AutoLink on. Opt in per deployment too (ABDM_AUTO_LINK=true), so every
        // developer's server sharing a database doesn't do it at once.
        if (process.env.ABDM_AUTO_LINK === "true") {
            const { hipLinkingService } = await import("./services/Abdm/m2/index.js");
            const { abdmFacilities } = await import("./services/Abdm/abdm-facilities.service.js");
            const minutes = Number(process.env.ABDM_AUTO_LINK_MINUTES) > 0 ? Number(process.env.ABDM_AUTO_LINK_MINUTES) : 15;
            setInterval(() => {
                abdmFacilities.hips({ autoLink: true })
                    .then((hips) => hipLinkingService.sweep(hips))
                    .then((r) => console.log(`[ABDM] linking sweep: ${r.patients} patients, ${r.queued} care contexts queued, ${r.notified} notified`))
                    .catch((error) => console.error("[ABDM] linking sweep failed:", error?.message));
            }, minutes * 60_000);
        }

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

        // Start the ABDM HIU housekeeping sweep (every 60s: purge records past dataEraseAt, fail timed-out transfers, delete private keys)
        const { startHiuMaintenance } = await import("./controllers/Abdm/hiu.controller.js");
        await startHiuMaintenance();

        app.listen(Number(port), "0.0.0.0", () => {
            console.log(`Server is running on port ${port} (0.0.0.0)`);
        });

    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
};

startServer();