import "reflect-metadata";
import { AppDataSource } from "../src/config/database.js";
import { UserDevice } from "../src/models/Account/userdevice.model.js";
import { AppNotification } from "../src/models/Common/app-notification.model.js";

async function run() {
    await AppDataSource.initialize();

    const deviceRepo = AppDataSource.getRepository(UserDevice);
    const notifRepo = AppDataSource.getRepository(AppNotification);

    const docId = "234154EE-E1EE-49D2-9577-F0DB190C827C";
    console.log("=== Active Devices in DB for Doctor Teja ch ===");
    const devices = await deviceRepo.find({ where: { UserId: docId } });
    console.log(devices.map(d => ({
        id: d.Id,
        userId: d.UserId,
        deviceType: d.DeviceType,
        tokenPrefix: d.FCMToken?.substring(0, 35) + "...",
        isActive: d.IsActive,
        updatedAt: d.UpdatedAt
    })));

    console.log("\n=== Inserting Test In-App Notification ===");
    const notif = new AppNotification();
    notif.UserId = docId;
    notif.Title = "🩺 Test Appointment Alert";
    notif.Body = "Rahul Verma booked an in-clinic consultation for Today at 10:30 AM.";
    notif.Type = "APPOINTMENT_BOOKED";
    notif.Route = "/doctorDashboard";
    notif.IsRead = false;
    notif.CreatedAt = new Date();
    await notifRepo.save(notif);
    console.log("Saved notification ID:", notif.Id);

    await AppDataSource.destroy();
}

run().catch(console.error);
