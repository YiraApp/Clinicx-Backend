import { AppDataSource } from "../../config/database.js";

export class MigrationService {
    static async ensureLogIndexes() {
        try {
            console.log("Checking APILog indexes...");
            const queries = [
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_APILogs_RequestedOn' AND object_id = OBJECT_ID('APILogs')) CREATE INDEX IX_APILogs_RequestedOn ON APILogs (RequestedOn DESC);",
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_APILogs_LogId_DESC' AND object_id = OBJECT_ID('APILogs')) CREATE INDEX IX_APILogs_LogId_DESC ON APILogs (LogId DESC);",
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_APILogs_Method' AND object_id = OBJECT_ID('APILogs')) CREATE INDEX IX_APILogs_Method ON APILogs (Method);",
                
                // Consent Request Schema Updates
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ConsentRequests') AND name = 'SignedPdfUrl') ALTER TABLE ConsentRequests ADD SignedPdfUrl NVARCHAR(MAX) NULL;",
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ConsentRequests') AND name = 'SignatureImageUrl') ALTER TABLE ConsentRequests ADD SignatureImageUrl NVARCHAR(MAX) NULL;",

                // Consent Template Fields Schema Updates
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ConsentTemplateFields') AND name = 'FieldKey') ALTER TABLE ConsentTemplateFields ADD FieldKey NVARCHAR(100) NULL;",

                // Password Reset Tokens Table
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PasswordResetTokens')
                CREATE TABLE PasswordResetTokens (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    UserId UNIQUEIDENTIFIER NOT NULL,
                    Token VARCHAR(500) NOT NULL,
                    ExpiryTime DATETIME NOT NULL,
                    IsUsed BIT DEFAULT 0,
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UsedAt DATETIME NULL,
                    CONSTRAINT FK_PasswordResetTokens_Users FOREIGN KEY (UserId) REFERENCES Users(Id)
                );`,

                // Patient Access Consents Table (Doctor Medical Record Access Permissions)
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PatientAccessConsents')
                CREATE TABLE PatientAccessConsents (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    PatientId UNIQUEIDENTIFIER NOT NULL,
                    DoctorId UNIQUEIDENTIFIER NOT NULL,
                    HospitalId INT NULL,
                    OrganizationId INT NULL,
                    Duration NVARCHAR(50) NOT NULL,
                    DurationMinutes INT NOT NULL DEFAULT 60,
                    Status NVARCHAR(50) NOT NULL DEFAULT 'PENDING',
                    RequestedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    ApprovedAt DATETIME NULL,
                    ExpiresAt DATETIME NULL,
                    Notes NVARCHAR(500) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UpdatedAt DATETIME DEFAULT GETDATE()
                );`,

                // Seed default AppVersions if not existing
                `IF NOT EXISTS (SELECT * FROM AppVersions WHERE Platform = 'android')
                INSERT INTO AppVersions (Platform, Version, MinVersion, ForceUpdate, Url, IsLatest, IsDeleted, CreatedAt, Maintenance, Logout)
                VALUES ('android', '1.0.0', '1.0.0', 0, 'https://play.google.com/store/apps/details?id=ai.yira.clinicx', 1, 0, GETDATE(), 0, 0);`,

                `IF NOT EXISTS (SELECT * FROM AppVersions WHERE Platform = 'ios')
                INSERT INTO AppVersions (Platform, Version, MinVersion, ForceUpdate, Url, IsLatest, IsDeleted, CreatedAt, Maintenance, Logout)
                VALUES ('ios', '1.0.0', '1.0.0', 0, 'https://apps.apple.com/app/yira-clinx/id6741477759', 1, 0, GETDATE(), 0, 0);`
            ];

            for (const query of queries) {
                await AppDataSource.query(query);
            }
            console.log("APILog indexes guaranteed.");
        } catch (error) {
            console.error("Failed to ensure log indexes:", error);
        }
    }

    /**
     * ABDM (ABHA) schema. The User and PatientRegistration entities map these columns, so a failure
     * here stops startup rather than leaving every patient query broken.
     */
    static async ensureAbdmSchema() {
        const statements = [
            // ABHA number and preferred ABHA address beside the patient's other identifiers
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'AbhaNumber') ALTER TABLE Users ADD AbhaNumber VARCHAR(17) NULL;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'AbhaAddress') ALTER TABLE Users ADD AbhaAddress VARCHAR(100) NULL;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'AbhaLinkedAt') ALTER TABLE Users ADD AbhaLinkedAt DATETIME NULL;",

            // The person has come through ABHA somewhere (verified at a desk, or shared by Scan and Share).
            // Added with a one-time backfill: every ABHA linked before the column existed came through that step.
            `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'RegisteredViaAbha')
            BEGIN
                ALTER TABLE Users ADD RegisteredViaAbha BIT NOT NULL CONSTRAINT DF_Users_RegisteredViaAbha DEFAULT 0;
                EXEC('UPDATE Users SET RegisteredViaAbha = 1 WHERE AbhaNumber IS NOT NULL');
            END`,

            // Registered through ABHA at this hospital: what a hospital's "From ABHA" patient filter reads.
            `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('PatientRegistrations') AND name = 'RegisteredViaAbha')
            BEGIN
                ALTER TABLE PatientRegistrations ADD RegisteredViaAbha BIT NOT NULL CONSTRAINT DF_PatientRegistrations_RegisteredViaAbha DEFAULT 0;
                EXEC('UPDATE pr SET RegisteredViaAbha = 1 FROM PatientRegistrations pr INNER JOIN Users u ON u.Id = pr.UserId WHERE u.AbhaNumber IS NOT NULL');
            END`,

            // One ABHA number links to one patient record
            `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_Users_AbhaNumber' AND object_id = OBJECT_ID('Users'))
            EXEC('CREATE UNIQUE NONCLUSTERED INDEX UX_Users_AbhaNumber ON Users (AbhaNumber) WHERE AbhaNumber IS NOT NULL AND IsDeleted = 0');`,

            // Who agreed to ABHA creation, who confirmed it at the desk, and when (no Aadhaar is stored)
            `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AbhaConsents')
            CREATE TABLE AbhaConsents (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                ConsentCode VARCHAR(50) NOT NULL,
                ConsentVersion VARCHAR(10) NOT NULL,
                Declarations NVARCHAR(MAX) NOT NULL,
                StaffUserId UNIQUEIDENTIFIER NOT NULL,
                StaffName NVARCHAR(200) NULL,
                BeneficiaryName NVARCHAR(200) NULL,
                HospitalId INT NULL,
                OrganizationId INT NULL,
                TxnId VARCHAR(64) NULL,
                AbhaNumber VARCHAR(17) NULL,
                PatientUserId UNIQUEIDENTIFIER NULL,
                AgreedAt DATETIME NOT NULL,
                CreatedAt DATETIME NOT NULL DEFAULT GETDATE()
            );`,

            // Scan and Share: each profile a patient shared at a counter, and the queue token sent back
            `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AbhaProfileShares')
            CREATE TABLE AbhaProfileShares (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                RequestId VARCHAR(64) NOT NULL,
                HipId VARCHAR(50) NOT NULL,
                CounterId VARCHAR(20) NOT NULL,
                AbhaNumber VARCHAR(17) NULL,
                AbhaAddress VARCHAR(100) NOT NULL,
                PatientName NVARCHAR(200) NULL,
                UserId UNIQUEIDENTIFIER NULL,
                HospitalId INT NULL,
                TokenNumber VARCHAR(20) NULL,
                ExpiresAt DATETIME NULL,
                Status VARCHAR(20) NOT NULL,
                MatchType VARCHAR(20) NULL,
                Error NVARCHAR(500) NULL,
                CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                UpdatedAt DATETIME NULL
            );`,
            // A share ABDM retries is processed once
            `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_AbhaProfileShares_RequestId' AND object_id = OBJECT_ID('AbhaProfileShares'))
            CREATE UNIQUE INDEX UX_AbhaProfileShares_RequestId ON AbhaProfileShares (RequestId);`,
            `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_AbhaProfileShares_Queue' AND object_id = OBJECT_ID('AbhaProfileShares'))
            CREATE INDEX IX_AbhaProfileShares_Queue ON AbhaProfileShares (HospitalId, CounterId, CreatedAt DESC);`,
        ];

        for (const statement of statements) {
            try {
                await AppDataSource.query(statement);
            } catch (error: any) {
                throw new Error(`ABDM schema migration failed (${statement.trim().split("\n")[0]!.slice(0, 120)}): ${error?.message}`);
            }
        }
        console.log("ABDM schema guaranteed.");
    }
}
