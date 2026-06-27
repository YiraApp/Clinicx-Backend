import { AppDataSource } from "../src/config/database.js";
import { User } from "../src/models/Account/user.model.js";
import { UserRole } from "../src/models/Account/userrole.model.js";
import { Appointment } from "../src/models/Appointments/appointment.model.js";

async function test() {
    console.log("Initializing DB connection...");
    await AppDataSource.initialize();
    console.log("DB Connected!");

    // Search for a patient (Role ID: 4fc67429-28ae-4106-93ef-436228282ed0)
    const patientRole = await AppDataSource.getRepository(UserRole).findOne({
        where: { RoleId: "4fc67429-28ae-4106-93ef-436228282ed0", IsDeleted: false },
        relations: ["User"]
    });

    if (!patientRole) {
        console.log("No patient users found.");
    } else {
        console.log("Patient found:");
        console.log("User ID:", patientRole.UserId);
        console.log("Name:", patientRole.User.FirstName, patientRole.User.LastName);
        console.log("Email:", patientRole.User.Email);
        console.log("Phone:", patientRole.User.PhoneNumber);
        
        // Count their appointments
        const count = await AppDataSource.getRepository(Appointment).count({
            where: { UserId: patientRole.UserId }
        });
        console.log("Total appointments:", count);

        if (count > 0) {
            const sampleAppts = await AppDataSource.getRepository(Appointment).find({
                where: { UserId: patientRole.UserId },
                take: 2,
                relations: ["Hospital"]
            });
            console.log("Sample appointments hospitals:");
            for (const appt of sampleAppts) {
                console.log(`- Hospital ID: ${appt.HospitalId}, Name: ${appt.Hospital?.Name}, Status: ${appt.Status}`);
            }
        }
    }

    await AppDataSource.destroy();
}

test().catch(err => {
    console.error(err);
    process.exit(1);
});
