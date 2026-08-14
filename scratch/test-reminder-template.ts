import dotenv from "dotenv";
dotenv.config();

import { initializeDatabase, AppDataSource } from "../src/config/database.js";
import { appointmentReminderService } from "../src/services/Appointments/appointment-reminder.service.js";
import { Appointment } from "../src/models/Appointments/appointment.model.js";

async function testReminder() {
    console.log("==================================================");
    console.log("🧪 Testing WhatsApp Reminder Template (remainder_template)");
    console.log("==================================================");

    try {
        await initializeDatabase();
        console.log("Database initialized.");

        // Find the latest appointment
        const sampleAppt = await AppDataSource.getRepository(Appointment).findOne({
            where: {},
            order: { Id: "DESC" },
            relations: ["User", "Doctor", "Hospital"]
        });

        if (!sampleAppt) {
            console.log("No appointments found to test with.");
            process.exit(0);
        }

        console.log(`Found sample appointment ID: ${sampleAppt.Id} for Date: ${sampleAppt.AppointmentDate}, Time: ${sampleAppt.StartTime}`);

        console.log("\nSimulating 10-minute appointment reminder dispatch...");
        const result = await appointmentReminderService.sendAppointmentReminder(sampleAppt.Id, "10 minutes");
        console.log("Result:", JSON.stringify(result, null, 2));

        console.log("\n==================================================");
        console.log("✅ Reminder template test execution finished!");
        console.log("==================================================");
        process.exit(0);
    } catch (err: any) {
        console.error("Test Error:", err.message);
        process.exit(1);
    }
}

testReminder();
