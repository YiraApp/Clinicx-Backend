import { AppDataSource } from "../src/config/database.js";

async function run() {
    await AppDataSource.initialize();
    console.log("Connected to DB.");

    // Update Hospital 19 (Yira Hospitals) with official SVG logo
    const result19 = await AppDataSource.query(`
        UPDATE Hospitals 
        SET ImageUrl = 'https://yiraappdev.blob.core.windows.net/adminuploadedfiles/yiraai.svg'
        WHERE Id = 19
    `);
    console.log("Updated Hospital 19 ImageUrl:", result19);

    // Update Organization 1 (yira) with official SVG logo
    const resultOrg1 = await AppDataSource.query(`
        UPDATE Organizations 
        SET ImageUrl = 'https://yiraappdev.blob.core.windows.net/adminuploadedfiles/yiraai.svg'
        WHERE Id = 1
    `);
    console.log("Updated Org 1 ImageUrl:", resultOrg1);

    // Verify
    const hosp = await AppDataSource.query(`
        SELECT Id, Name, HospitalCode, ImageUrl FROM Hospitals WHERE Id = 19
    `);
    console.log("Hospital 19 now in DB:", hosp);

    const org = await AppDataSource.query(`
        SELECT Id, Name, OrgCode, ImageUrl FROM Organizations WHERE Id = 1
    `);
    console.log("Organization 1 now in DB:", org);

    await AppDataSource.destroy();
}

run().catch(console.error);
