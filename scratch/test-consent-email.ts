import { AppDataSource } from "../src/config/database.js";
import { mailService } from "../src/services/Mail/mail.service.js";

async function run() {
    try {
        await AppDataSource.initialize();
        console.log("DB connected successfully.");

        console.log("Sending dynamic consent email to neelimanikanta02@gmail.com...");
        await mailService.sendDynamicEmail("CONSENT_EMAIL", "neelimanikanta02@gmail.com", {
            PatientName: "Neeli Manikanta",
            HospitalName: "Yira Clinic Test Hospital",
            ConsentLink: "https://clinicx.azurewebsites.net/sign-consent/test-uuid-12345"
        });

        console.log("SUCCESS: Dynamic consent email sent!");
    } catch (error) {
        console.error("FAILURE:", error);
    } finally {
        if (AppDataSource.isInitialized) {
            await AppDataSource.destroy();
        }
    }
}

run();
