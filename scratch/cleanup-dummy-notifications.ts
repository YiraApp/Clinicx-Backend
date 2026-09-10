import { AppDataSource } from "../src/config/database.js";
import { AppNotification } from "../src/models/Common/app-notification.model.js";

async function cleanupDummyNotifications() {
    try {
        console.log("=== CLEANING UP DUMMY NOTIFICATIONS FROM DATABASE ===");
        await AppDataSource.initialize();
        const repo = AppDataSource.getRepository(AppNotification);

        const initialCount = await repo.count();
        console.log(`Total notifications before cleanup: ${initialCount}`);

        // 1. Delete TEST_PUSH and TEST dummy items
        await AppDataSource.query(`
            DELETE FROM AppNotifications 
            WHERE Type IN ('TEST_PUSH', 'TEST')
               OR Title LIKE '%Test Push%'
               OR Title LIKE '%Test Appointment Alert%'
        `);
        console.log("Deleted test push records");

        // 2. Delete WhatsApp internal debug documents log
        await AppDataSource.query(`
            DELETE FROM AppNotifications 
            WHERE Type LIKE 'WHATSAPP_%'
               OR Title LIKE 'Document Shared%'
        `);
        console.log("Deleted internal WhatsApp document logs");

        // 3. Clean up multiple duplicate broadcast campaign pushes (keep max 1 per user per title)
        // Keep the latest 1 record for repetitive campaign titles, delete the older duplicates
        await AppDataSource.query(`
            WITH RankedNotifs AS (
                SELECT Id,
                       ROW_NUMBER() OVER (
                           PARTITION BY UserId, Title 
                           ORDER BY CreatedAt DESC
                       ) as RowNum
                FROM AppNotifications
                WHERE Type IN ('PROMOTIONS', 'HEALTH_TIPS', 'OFFER_PROMOTION')
            )
            DELETE FROM AppNotifications
            WHERE Id IN (
                SELECT Id FROM RankedNotifs WHERE RowNum > 1
            )
        `);
        console.log("Deduplicated repetitive campaign pushes (preserved latest 1 per user)");

        const finalCount = await repo.count();
        console.log(`Total notifications after cleanup: ${finalCount}`);
        console.log(`Cleaned up ${initialCount - finalCount} obsolete / duplicate dummy records!`);

        process.exit(0);
    } catch (err) {
        console.error("Error cleaning up dummy notifications:", err);
        process.exit(1);
    }
}

cleanupDummyNotifications();
