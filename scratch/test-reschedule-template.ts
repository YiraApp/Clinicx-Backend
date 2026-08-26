import dotenv from "dotenv";
dotenv.config();

import { initializeDatabase, AppDataSource } from "../src/config/database.js";
import { Appointment } from "../src/models/Appointments/appointment.model.js";
import { whatsappService } from "../src/services/Common/whatsapp.service.js";

async function testRescheduleTemplate() {
    console.log("==================================================");
    console.log("🧪 Testing WhatsApp Reschedule Template (appointment_rescheduled)");
    console.log("==================================================");

    try {
        await initializeDatabase();
        console.log("Database initialized.");

        // Find sample appointment
        const sampleAppt = await AppDataSource.getRepository(Appointment).findOne({
            where: {},
            order: { Id: "DESC" },
            relations: ["User", "Doctor", "Hospital"]
        });

        if (!sampleAppt || !sampleAppt.User) {
            console.log("No appointments found.");
            process.exit(0);
        }

        console.log(`Found appointment #${sampleAppt.Id}`);

        const patientName = `${sampleAppt.User?.FirstName || ""} ${sampleAppt.User?.LastName || ""}`.trim() || "Patient";
        const doctorName = sampleAppt.Doctor 
            ? `Dr. ${sampleAppt.Doctor.FirstName || ""} ${sampleAppt.Doctor.LastName || ""}`.trim()
            : "your doctor";

        const dateObj = new Date(sampleAppt.AppointmentDate);
        const dateStr = !isNaN(dateObj.getTime())
            ? dateObj.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
            : String(sampleAppt.AppointmentDate);

        let timeStr = sampleAppt.StartTime ? sampleAppt.StartTime.slice(0, 5) : "";
        if (sampleAppt.StartTime && sampleAppt.StartTime.includes(":")) {
            const [h, m] = sampleAppt.StartTime.split(":");
            const hourNum = parseInt(h, 10);
            const period = hourNum >= 12 ? "PM" : "AM";
            const displayHour = hourNum % 12 || 12;
            timeStr = `${displayHour}:${m} ${period}`;
        }

        let locationStr = sampleAppt.Hospital?.Name || "our clinic";
        if (sampleAppt.IsTeleConsultation) {
            locationStr = "Online Video Consultation";
        }

        const countryCode = sampleAppt.User.CountryCode || "91";
        const normalizedPhone = `${countryCode.replace(/\D/g, "")}${sampleAppt.User.PhoneNumber.replace(/\D/g, "")}`;

        // Template has 5 body parameters: {{1}} to {{5}}
        const components: any[] = [
            {
                type: "body",
                parameters: [
                    { type: "text", text: patientName },   // {{1}}
                    { type: "text", text: doctorName },    // {{2}}
                    { type: "text", text: dateStr },        // {{3}}
                    { type: "text", text: timeStr },        // {{4}}
                    { type: "text", text: locationStr }     // {{5}}
                ]
            }
        ];

        console.log(`\nDispatching appointment_rescheduled template to ${normalizedPhone}...`);
        console.log("Variables:", {
            "{{1}} Patient": patientName,
            "{{2}} Doctor": doctorName,
            "{{3}} Date": dateStr,
            "{{4}} Time": timeStr,
            "{{5}} Location": locationStr
        });

        const res = await whatsappService.sendTemplateMessage(normalizedPhone, "appointment_rescheduled", "en", components);
        console.log("API Response:", res);
        console.log("\n==================================================");
        console.log("✅ appointment_rescheduled WhatsApp template sent successfully!");
        console.log("==================================================");
        process.exit(0);
    } catch (err: any) {
        console.error("Test Error:", err.message);
        process.exit(1);
    }
}

testRescheduleTemplate();
