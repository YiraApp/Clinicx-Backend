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
}
