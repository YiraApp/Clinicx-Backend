import { AppDataSource } from "../src/config/database.js";

async function run() {
    await AppDataSource.initialize();
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();

    try {
        await queryRunner.startTransaction();

        console.log("Previewing duplicate diagnoses...");
        const dupDiags = await queryRunner.query(`
            SELECT PrescriptionId, LOWER(RTRIM(LTRIM(Diagnosis))) AS DiagnosisNorm, ISNULL(DiagnosisConceptId,'') AS ConceptId, COUNT(*) AS cnt
            FROM PrescriptionDiagnosis
            GROUP BY PrescriptionId, LOWER(RTRIM(LTRIM(Diagnosis))), ISNULL(DiagnosisConceptId,'')
            HAVING COUNT(*) > 1
        `);
        console.table(dupDiags);

        console.log("Previewing duplicate medications...");
        const dupMeds = await queryRunner.query(`
            SELECT PrescriptionId,
              LOWER(RTRIM(LTRIM(Medication))) AS MedNorm,
              ISNULL(LOWER(RTRIM(LTRIM(Dosage))),'') AS DosageNorm,
              ISNULL(LOWER(RTRIM(LTRIM(FrequencyType))),'') AS FreqNorm,
              ISNULL(LOWER(RTRIM(LTRIM(DurationUnit))),'') AS DurNorm,
              ISNULL(LOWER(RTRIM(LTRIM(Route))),'') AS RouteNorm,
              ISNULL(LOWER(RTRIM(LTRIM(Instructions))),'') AS InstrNorm,
              COUNT(*) AS cnt
            FROM PrescriptionMedication
            GROUP BY PrescriptionId,
              LOWER(RTRIM(LTRIM(Medication))),
              ISNULL(LOWER(RTRIM(LTRIM(Dosage))),'') ,
              ISNULL(LOWER(RTRIM(LTRIM(FrequencyType))),'') ,
              ISNULL(LOWER(RTRIM(LTRIM(DurationUnit))),'') ,
              ISNULL(LOWER(RTRIM(LTRIM(Route))),'') ,
              ISNULL(LOWER(RTRIM(LTRIM(Instructions))),'') 
            HAVING COUNT(*) > 1
        `);
        console.table(dupMeds);

        if (dupDiags.length === 0 && dupMeds.length === 0) {
            console.log("No duplicates found. Nothing to do.");
            await queryRunner.rollbackTransaction();
            return;
        }

        console.log("Deleting duplicate diagnoses (keeping earliest CreatedAt)...");
        await queryRunner.query(`
            WITH Ranked AS (
              SELECT Id,
                ROW_NUMBER() OVER (
                  PARTITION BY PrescriptionId, LOWER(RTRIM(LTRIM(Diagnosis))), ISNULL(DiagnosisConceptId,'')
                  ORDER BY CreatedAt ASC, Id ASC
                ) rn
              FROM PrescriptionDiagnosis
            )
            DELETE FROM PrescriptionDiagnosis WHERE Id IN (SELECT Id FROM Ranked WHERE rn > 1);
        `);

        console.log("Deleting duplicate medications (keeping earliest CreatedAt)...");
        await queryRunner.query(`
            WITH RankedMed AS (
              SELECT Id,
                ROW_NUMBER() OVER (
                  PARTITION BY PrescriptionId,
                    LOWER(RTRIM(LTRIM(Medication))),
                    ISNULL(LOWER(RTRIM(LTRIM(Dosage))),'') ,
                    ISNULL(LOWER(RTRIM(LTRIM(FrequencyType))),'') ,
                    ISNULL(LOWER(RTRIM(LTRIM(DurationUnit))),'') ,
                    ISNULL(LOWER(RTRIM(LTRIM(Route))),'') ,
                    ISNULL(LOWER(RTRIM(LTRIM(Instructions))),'')
                  ORDER BY CreatedAt ASC, Id ASC
                ) rn
              FROM PrescriptionMedication
            )
            DELETE FROM PrescriptionMedication WHERE Id IN (SELECT Id FROM RankedMed WHERE rn > 1);
        `);

        await queryRunner.commitTransaction();
        console.log("Duplicate cleanup completed successfully.");
    } catch (err) {
        console.error("Error during cleanup, rolling back:", err);
        try { await queryRunner.rollbackTransaction(); } catch (e) { console.error(e); }
    } finally {
        await queryRunner.release();
        await AppDataSource.destroy();
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
