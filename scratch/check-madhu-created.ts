import "reflect-metadata";
import { AppDataSource } from "../src/config/database.js";

async function run() {
    await AppDataSource.initialize();
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();

    const madhuId = "5EDACAC0-EE00-4334-B058-55345F3192D8";

    const user = await queryRunner.query("SELECT Id, PhoneNumber, FirstName, LastName, Email, IsPrimary FROM Users WHERE Id = @0", [madhuId]);
    console.log("Users:", user);

    const userRoles = await queryRunner.query("SELECT * FROM UserRoles WHERE UserId = @0", [madhuId]);
    console.log("UserRoles:", userRoles);

    const docs = await queryRunner.query("SELECT Id, FileName FROM MedicalDocuments WHERE PatientId = @0", [madhuId]);
    console.log("MedicalDocuments count:", docs.length);

    await queryRunner.release();
    await AppDataSource.destroy();
}

run().catch(console.error);
