import { AppDataSource } from "./src/config/database.js";

async function updateTemplates() {
    try {
        await AppDataSource.initialize();
        console.log("DB connected.");

        await AppDataSource.query(`
            UPDATE ConsentTemplates 
            SET OrganizationId = 3, HospitalId = 1
            WHERE TemplateId IN (1, 2)
        `);

        console.log("Templates updated to Org 3 and Hosp 1.");
        await AppDataSource.destroy();
    } catch (error) {
        console.error(error);
    }
}
updateTemplates();
