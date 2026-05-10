import { AppDataSource } from "../src/config/database";

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
        } catch (e: any) {
            console.log("Route column update status:", e.message);
        }

        console.log("Adding Diagnosis column...");
        try {
            await queryRunner.query(`ALTER TABLE PatientPrescription ADD Diagnosis nvarchar(255) NULL`);
            console.log("Diagnosis column added.");
        } catch (e: any) {
            console.log("Diagnosis column update status:", e.message);
        }

        console.log("Adding DiagnosisConceptId column...");
        try {
            await queryRunner.query(`ALTER TABLE PatientPrescription ADD DiagnosisConceptId nvarchar(100) NULL`);
            console.log("DiagnosisConceptId column added.");
        } catch (e: any) {
            console.log("DiagnosisConceptId column update status:", e.message);
        }

        await queryRunner.release();
        await AppDataSource.destroy();
        console.log("Done.");
    } catch (err) {
        console.error("Error updating schema:", err);
    }
}

updateSchema();
