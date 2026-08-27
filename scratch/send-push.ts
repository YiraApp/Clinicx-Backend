import "reflect-metadata";
import { AppDataSource } from "../src/config/database.js";
import { PushNotificationService } from "../src/services/Notifications/push-notification.service.js";

async function main() {
    await AppDataSource.initialize();

    const pushService = new PushNotificationService();
    const docId = "234154EE-E1EE-49D2-9577-F0DB190C827C"; // Dr. Teja ch (6303012453)

    console.log(`\n🔔 Dispatching live push notification to Doctor (ID: ${docId})...`);
    const notif = await pushService.sendNotification({
        userId: docId,
        title: "🩺 Yira Clinx: New Appointment Booked",
        body: "Rahul Verma booked an in-clinic consultation for Today at 10:30 AM.",
        type: "APPOINTMENT_BOOKED",
        route: "/doctorDashboard",
        additionalData: {
            doctorName: "Dr. Teja ch",
            patientName: "Rahul Verma",
            time: "10:30 AM",
            clinic: "Yira Hospital"
        }
    });

    console.log("✅ Push notification processed and stored in database with ID:", notif.Id);
    await AppDataSource.destroy();
}

main().catch(console.error);
