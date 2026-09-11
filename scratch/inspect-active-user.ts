import { AppDataSource } from "../src/config/database.js";
import { User } from "../src/models/Account/user.model.js";
import { Appointment } from "../src/models/Appointments/appointment.model.js";

async function test() {
    await AppDataSource.initialize();
    const user = await AppDataSource.getRepository(User).findOne({
        where: { Id: "C6D7853D-CA74-4E4E-AC2F-392450BEAAEC" },
        relations: ["UserRoles"]
    });
    console.log("User C6D7853D-CA74-4E4E-AC2F-392450BEAAEC:", user);

    const appts = await AppDataSource.getRepository(Appointment).find({
        where: { UserId: "C6D7853D-CA74-4E4E-AC2F-392450BEAAEC" },
        relations: ["Hospital", "Organization"]
    });
    console.log("Appointments count:", appts.length);
    for (const a of appts) {
        console.log(`Appt ${a.Id}: hosp=${a.HospitalId} (${a.Hospital?.Name}), status=${a.Status}`);
    }

    await AppDataSource.destroy();
}

test().catch(console.error);
