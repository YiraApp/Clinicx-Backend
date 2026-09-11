import { AppDataSource } from "../src/config/database.js";

async function run() {
    await AppDataSource.initialize();
    const withImages = await AppDataSource.query(`
        SELECT Id, Name, HospitalCode, ImageUrl FROM Hospitals WHERE ImageUrl IS NOT NULL
    `);
    console.log("Hospitals with ImageUrl:", withImages);

    const orgsWithImages = await AppDataSource.query(`
        SELECT Id, Name, OrgCode, ImageUrl FROM Organizations WHERE ImageUrl IS NOT NULL
    `);
    console.log("Organizations with ImageUrl:", orgsWithImages);

    // Let's see all hospitals
    const allHosp = await AppDataSource.query(`
        SELECT Id, Name, HospitalCode, OrganizationId, ImageUrl FROM Hospitals
    `);
    console.log("All Hospitals:", allHosp);

    await AppDataSource.destroy();
}

run().catch(console.error);
