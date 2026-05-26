import { AppDataSource } from "../src/config/database.js";

async function updatePrescriptionSchema() {
    try {
        await AppDataSource.initialize();
        console.log("Connected to database.");

        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();

        console.log("Creating backup of PatientPrescription...");
        await queryRunner.query(`
            IF OBJECT_ID('dbo.PatientPrescription_backup','U') IS NULL
            BEGIN
                SELECT * INTO dbo.PatientPrescription_backup FROM dbo.PatientPrescription;
            END
        `);

        console.log("Creating PrescriptionDiagnosis table...");
        await queryRunner.query(`
            IF OBJECT_ID('dbo.PrescriptionDiagnosis','U') IS NULL
            BEGIN
                CREATE TABLE PrescriptionDiagnosis (
                    Id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
                    PrescriptionId UNIQUEIDENTIFIER NOT NULL,
                    Diagnosis NVARCHAR(500) NOT NULL,
                    DiagnosisConceptId NVARCHAR(100) NULL,
                    CreatedAt DATETIME NOT NULL DEFAULT GETUTCDATE(),
                    CreatedBy UNIQUEIDENTIFIER NULL,
                    CONSTRAINT FK_PrescriptionDiagnosis_Prescription FOREIGN KEY (PrescriptionId) REFERENCES PatientPrescription(Id)
                );
            END
        `);

        console.log("Creating PrescriptionMedication table...");
        await queryRunner.query(`
            IF OBJECT_ID('dbo.PrescriptionMedication','U') IS NULL
            BEGIN
                CREATE TABLE PrescriptionMedication (
                    Id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
                    PrescriptionId UNIQUEIDENTIFIER NOT NULL,
                    Medication NVARCHAR(500) NOT NULL,
                    ConceptId NVARCHAR(100) NULL,
                    Dosage NVARCHAR(100) NULL,
                    DurationValue INT NULL,
                    DurationUnit NVARCHAR(50) NULL,
                    FrequencyType NVARCHAR(50) NULL,
                    Instructions NVARCHAR(MAX) NULL,
                    Route NVARCHAR(100) NULL,
                    CreatedAt DATETIME NOT NULL DEFAULT GETUTCDATE(),
                    UpdatedAt DATETIME NULL,
                    CreatedBy UNIQUEIDENTIFIER NULL,
                    UpdatedBy UNIQUEIDENTIFIER NULL,
                    CONSTRAINT FK_PrescriptionMedication_Prescription FOREIGN KEY (PrescriptionId) REFERENCES PatientPrescription(Id)
                );
            END
        `);

        console.log("Creating PrescriptionMedicationSchedule table...");
        await queryRunner.query(`
            IF OBJECT_ID('dbo.PrescriptionMedicationSchedule','U') IS NULL
            BEGIN
                CREATE TABLE PrescriptionMedicationSchedule (
                    Id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
                    PrescriptionMedicationId UNIQUEIDENTIFIER NOT NULL,
                    TimeSlot NVARCHAR(50) NOT NULL,
                    Dose DECIMAL(4,2) NOT NULL,
                    MealTiming NVARCHAR(50) NULL,
                    MealType NVARCHAR(50) NULL,
                    CreatedAt DATETIME NOT NULL DEFAULT GETUTCDATE(),
                    CONSTRAINT FK_PrescriptionMedicationSchedule_Medication FOREIGN KEY (PrescriptionMedicationId) REFERENCES PrescriptionMedication(Id)
                );
            END
        `);

        console.log("Creating PrescriptionMedicationDays table...");
        await queryRunner.query(`
            IF OBJECT_ID('dbo.PrescriptionMedicationDays','U') IS NULL
            BEGIN
                CREATE TABLE PrescriptionMedicationDays (
                    Id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
                    PrescriptionMedicationId UNIQUEIDENTIFIER NOT NULL,
                    DayOfWeek INT NOT NULL,
                    CreatedAt DATETIME NOT NULL DEFAULT GETUTCDATE(),
                    CONSTRAINT FK_PrescriptionMedicationDays_Medication FOREIGN KEY (PrescriptionMedicationId) REFERENCES PrescriptionMedication(Id)
                );
            END
        `);

        console.log("Migrating existing prescription data into the new medication table...");
        await queryRunner.query(`
            INSERT INTO PrescriptionMedication (Id, PrescriptionId, Medication, ConceptId, Dosage, DurationValue, DurationUnit, FrequencyType, Instructions, Route, CreatedAt, CreatedBy)
            SELECT NEWID(), Id, Medication, ConceptId, Dosage, NULL, Duration, Frequency, Instructions, Route, CreatedAt, CreatedBy
            FROM PatientPrescription_backup
            WHERE Medication IS NOT NULL OR ConceptId IS NOT NULL OR Dosage IS NOT NULL OR Frequency IS NOT NULL OR Duration IS NOT NULL OR Instructions IS NOT NULL OR Route IS NOT NULL;
        `);

        console.log("Migrating existing diagnosis values into the new diagnosis table...");
        await queryRunner.query(`
            INSERT INTO PrescriptionDiagnosis (Id, PrescriptionId, Diagnosis, DiagnosisConceptId, CreatedAt, CreatedBy)
            SELECT NEWID(), Id, Diagnosis, DiagnosisConceptId, CreatedAt, CreatedBy
            FROM PatientPrescription_backup
            WHERE Diagnosis IS NOT NULL AND LTRIM(RTRIM(Diagnosis)) <> '';
        `);

        const nullableColumns = [
            { name: "Medication", definition: "NVARCHAR(500) NULL" },
            { name: "ConceptId", definition: "NVARCHAR(100) NULL" },
            { name: "Dosage", definition: "NVARCHAR(100) NULL" },
            { name: "Frequency", definition: "NVARCHAR(50) NULL" },
            { name: "Duration", definition: "NVARCHAR(50) NULL" },
            { name: "Instructions", definition: "NVARCHAR(MAX) NULL" },
            { name: "Route", definition: "NVARCHAR(100) NULL" },
            { name: "Diagnosis", definition: "NVARCHAR(500) NULL" },
            { name: "DiagnosisConceptId", definition: "NVARCHAR(100) NULL" }
        ];

        for (const column of nullableColumns) {
            console.log(`Ensuring legacy column ${column.name} is nullable if present...`);
            await queryRunner.query(`
                IF EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('PatientPrescription') AND name = '${column.name}')
                BEGIN
                    ALTER TABLE PatientPrescription ALTER COLUMN ${column.name} ${column.definition};
                END
            `);
        }

        const dropColumns = [
            "Medication",
            "ConceptId",
            "Dosage",
            "Frequency",
            "Duration",
            "Instructions",
            "Route",
            "Diagnosis",
            "DiagnosisConceptId"
        ];

        for (const columnName of dropColumns) {
            console.log(`Dropping column ${columnName} from PatientPrescription if present...`);
            await queryRunner.query(`
                IF EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('PatientPrescription') AND name = '${columnName}')
                BEGIN
                    ALTER TABLE PatientPrescription DROP COLUMN ${columnName};
                END
            `);
        }

        await queryRunner.release();
        await AppDataSource.destroy();
        console.log("Prescription schema refactor completed successfully.");
    } catch (error) {
        console.error("Error running prescription schema refactor:", error);
        process.exit(1);
    }
}

updatePrescriptionSchema();
