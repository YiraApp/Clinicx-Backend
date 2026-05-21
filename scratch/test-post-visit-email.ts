import { AppDataSource } from "../src/config/database.js";
import { postVisitService } from "../src/services/Appointments/post-visit.service.js";
import { appointmentRepository } from "../src/repositories/Appointments/appointment.repository.js";
import Readable from "stream";

async function run() {
    try {
        await AppDataSource.initialize();
        console.log("DB connected successfully.");

        // Find appointment 68 to make sure it exists
        const appointment = await appointmentRepository.findById(68);
        if (!appointment) {
            console.error("Appointment 68 not found in database.");
            return;
        }

        console.log(`Found appointment: ${appointment.Id} for patient ${appointment.User?.FirstName} ${appointment.User?.LastName || ""}, Email: ${appointment.User?.Email}`);
        
        // Let's set the email address to neelimanikanta02@gmail.com for testing if needed
        // Or keep it as is. Let's make sure it has an email:
        if (!appointment.User?.Email) {
            console.error("User has no email address configured!");
            return;
        }

        // Mock Express.Multer.File
        const mockFile: any = {
            fieldname: "files",
            originalname: "prescription_test_file.pdf",
            encoding: "7bit",
            mimetype: "application/pdf",
            buffer: Buffer.from("dummy pdf content"),
            size: 17,
            stream: new Readable()
        };

        console.log("Processing documents and sending email via postVisitService...");
        const result = await postVisitService.processDocuments(68, [mockFile], "email");
        console.log("SUCCESS: Result:", result);

    } catch (error) {
        console.error("FAILURE during post-visit test run:", error);
    } finally {
        if (AppDataSource.isInitialized) {
            await AppDataSource.destroy();
        }
    }
}

run();
