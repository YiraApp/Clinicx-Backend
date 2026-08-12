import dotenv from "dotenv";
dotenv.config();

import { initializeDatabase } from "../src/config/database.js";
import { appointmentService } from "../src/services/Appointments/appointment.service.js";

async function testRescheduleExecution() {
    await initializeDatabase();
    console.log("Database initialized.\n");

    try {
        console.log("Testing rescheduleAppointment for Appt #237...");
        const result = await appointmentService.rescheduleAppointment(237, {
            newSlotId: 1, // sample slot
            newDoctorId: "6CDE8235-B520-4442-B912-9622A9D357D0",
            newDate: "2026-08-12",
            startTime: "12:30:00",
            endTime: "13:00:00"
        });
        console.log("Reschedule completed successfully:", result?.Id);
    } catch (e: any) {
        console.error("Reschedule call error:", e.message);
        console.error(e);
    }
}

testRescheduleExecution().catch(console.error);
