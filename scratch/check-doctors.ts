import { AppDataSource } from "../src/config/database.js";
import { User } from "../src/models/Account/user.model.js";

async function run() {
    await AppDataSource.initialize();

    const u1 = await AppDataSource.getRepository(User).findOne({ where: { Id: "6CDE8235-B520-4442-B912-9622A9D357D0" } });
    const u2 = await AppDataSource.getRepository(User).findOne({ where: { Id: "234154EE-E1EE-49D2-9577-F0DB190C827C" } });

    console.log("Doctor 6CDE:", u1 ? `${u1.FirstName} ${u1.LastName} (${u1.PhoneNumber}) role=${u1.Relation}` : "Not found");
    console.log("User 2341:", u2 ? `${u2.FirstName} ${u2.LastName} (${u2.PhoneNumber}) role=${u2.Relation}` : "Not found");

    await AppDataSource.destroy();
}

run().catch(console.error);
