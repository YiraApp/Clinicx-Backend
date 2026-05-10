import { AppDataSource } from "../src/config/database.js";

async function updateSchema() {
    try {
        await AppDataSource.initialize();
        console.log("Database connected.");

        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();

        console.log("Adding Route column...");
        try {
            await queryRunner.query(`ALTER TABLE PatientPrescription ADD Route nvarchar(100) NULL`);
            console.log("Route column added.");
        } catch (e) {
            console.log("Route column might already exist.");
        }

        console.log("Adding Diagnosis column...");
        try {
            await queryRunner.query(`ALTER TABLE PatientPrescription ADD Diagnosis nvarchar(255) NULL`);
            console.log("Diagnosis column added.");
        } catch (e) {
            console.log("Diagnosis column might already exist.");
        }

        console.log("Adding DiagnosisConceptId column...");
        try {
            await queryRunner.query(`ALTER TABLE PatientPrescription ADD DiagnosisConceptId nvarchar(100) NULL`);
            console.log("DiagnosisConceptId column added.");
        } catch (e) {
            console.log("DiagnosisConceptId column might already exist.");
        }

        await queryRunner.release();
        await AppDataSource.destroy();
        console.log("Done.");
    } catch (err) {
        console.error("Error updating schema:", err);
    }
}

updateSchema();
