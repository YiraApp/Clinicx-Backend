import { AppDataSource } from "./dist/config/database.js";
import { patientRegistrationRepository } from "./dist/repositories/Organizations/patient-registration.repository.js";

async function test() {
    await AppDataSource.initialize();
    console.log("DB Connected");
    
    // Find a valid organizationId by querying PatientRegistration table
    const firstReg = await AppDataSource.getRepository("PatientRegistration").findOne({ where: { IsDeleted: false } });
    if (!firstReg) {
        console.log("No patient registrations found in DB");
        await AppDataSource.destroy();
        return;
    }
    console.log("Found patient registration with Org ID:", firstReg.OrganizationId);

    const result = await patientRegistrationRepository.getPatients(1, 10, {
        organizationId: firstReg.OrganizationId,
        search: "mani"
    });
    console.log("Repository Result:", JSON.stringify(result.patients, null, 2));
    await AppDataSource.destroy();
}

test().catch(err => {
    console.error(err);
    process.exit(1);
});
