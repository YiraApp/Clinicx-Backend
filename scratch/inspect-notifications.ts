import { AppDataSource } from "../src/config/database.js";
import { AppNotification } from "../src/models/Common/app-notification.model.js";

async function checkNotifications() {
    try {
        await AppDataSource.initialize();
        const repo = AppDataSource.getRepository(AppNotification);
        const count = await repo.count();
        console.log(`Total AppNotifications in DB: ${count}`);

        const userNotifs = await repo.find({
            where: { UserId: "234154EE-E1EE-49D2-9577-F0DB190C827C" },
            order: { CreatedAt: "DESC" },
            take: 20
        });
        console.log("User notifications count:", userNotifs.length, "Sample:", JSON.stringify(userNotifs.slice(0, 5), null, 2));

        const userUnread = await repo.count({
            where: { UserId: "234154EE-E1EE-49D2-9577-F0DB190C827C", IsRead: false }
        });
        console.log("User unread count:", userUnread);

        process.exit(0);
    } catch (e) {
        console.error("Error inspecting notifications:", e);
        process.exit(1);
    }
}

checkNotifications();
