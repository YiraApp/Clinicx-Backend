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

                // Patient Profile Share Links (read-only web links for doctors not on Yira)
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PatientProfileShareLinks')
                CREATE TABLE PatientProfileShareLinks (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    PatientId UNIQUEIDENTIFIER NOT NULL,
                    CreatedByUserId UNIQUEIDENTIFIER NOT NULL,
                    TokenHash VARCHAR(64) NOT NULL,
                    Label NVARCHAR(120) NULL,
                    ExpiresAt DATETIME NOT NULL,
                    RevokedAt DATETIME NULL,
                    ViewCount INT NOT NULL DEFAULT 0,
                    LastViewedAt DATETIME NULL,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE()
                );`,
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_PatientProfileShareLinks_TokenHash' AND object_id = OBJECT_ID('PatientProfileShareLinks')) CREATE UNIQUE INDEX UX_PatientProfileShareLinks_TokenHash ON PatientProfileShareLinks (TokenHash);",
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_PatientProfileShareLinks_PatientId' AND object_id = OBJECT_ID('PatientProfileShareLinks')) CREATE INDEX IX_PatientProfileShareLinks_PatientId ON PatientProfileShareLinks (PatientId);",

                // My billing: bills patients add themselves
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PatientManualBills')
                CREATE TABLE PatientManualBills (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    PatientId UNIQUEIDENTIFIER NOT NULL,
                    CreatedByUserId UNIQUEIDENTIFIER NOT NULL,
                    Title NVARCHAR(150) NOT NULL,
                    ProviderName NVARCHAR(200) NULL,
                    Category VARCHAR(40) NOT NULL,
                    BillDate DATE NOT NULL,
                    BillNumber NVARCHAR(80) NULL,
                    TotalAmount DECIMAL(18,2) NOT NULL,
                    PaidAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    PaymentMode VARCHAR(40) NULL,
                    Notes NVARCHAR(1000) NULL,
                    FileUrl NVARCHAR(MAX) NULL,
                    FileName NVARCHAR(255) NULL,
                    IsDeleted BIT NOT NULL DEFAULT 0,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    UpdatedAt DATETIME NULL
                );`,
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_PatientManualBills_PatientId' AND object_id = OBJECT_ID('PatientManualBills')) CREATE INDEX IX_PatientManualBills_PatientId ON PatientManualBills (PatientId, BillDate DESC);",

                // My policies: insurance policies and schemes patients add themselves
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PatientPolicies')
                CREATE TABLE PatientPolicies (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    PatientId UNIQUEIDENTIFIER NOT NULL,
                    CreatedByUserId UNIQUEIDENTIFIER NOT NULL,
                    PolicyType VARCHAR(40) NOT NULL,
                    Insurer NVARCHAR(200) NOT NULL,
                    PolicyName NVARCHAR(200) NULL,
                    PolicyNumber NVARCHAR(100) NOT NULL,
                    MemberId NVARCHAR(100) NULL,
                    SumInsured DECIMAL(18,2) NULL,
                    Premium DECIMAL(18,2) NULL,
                    StartDate DATE NULL,
                    EndDate DATE NULL,
                    TpaName NVARCHAR(200) NULL,
                    HelplineNumber NVARCHAR(40) NULL,
                    CoveredMembers NVARCHAR(500) NULL,
                    Notes NVARCHAR(1000) NULL,
                    FileUrl NVARCHAR(MAX) NULL,
                    FileName NVARCHAR(255) NULL,
                    IsDeleted BIT NOT NULL DEFAULT 0,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    UpdatedAt DATETIME NULL
                );`,
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_PatientPolicies_PatientId' AND object_id = OBJECT_ID('PatientPolicies')) CREATE INDEX IX_PatientPolicies_PatientId ON PatientPolicies (PatientId);",

                // Lab tests: each hospital's list, and the tests doctors order
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'HospitalLabTests')
                CREATE TABLE HospitalLabTests (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    HospitalId INT NOT NULL,
                    OrganizationId INT NULL,
                    TestName NVARCHAR(200) NOT NULL,
                    TestCode NVARCHAR(50) NULL,
                    Category NVARCHAR(100) NOT NULL,
                    SampleType NVARCHAR(100) NULL,
                    Price DECIMAL(18,2) NULL,
                    Preparation NVARCHAR(500) NULL,
                    IsActive BIT NOT NULL DEFAULT 1,
                    IsDeleted BIT NOT NULL DEFAULT 0,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    UpdatedAt DATETIME NULL
                );`,
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_HospitalLabTests_Hospital') CREATE INDEX IX_HospitalLabTests_Hospital ON HospitalLabTests(HospitalId, IsDeleted, IsActive);",
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PrescriptionLabTests')
                CREATE TABLE PrescriptionLabTests (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    PrescriptionId UNIQUEIDENTIFIER NOT NULL,
                    HospitalLabTestId INT NULL,
                    TestName NVARCHAR(200) NOT NULL,
                    Category NVARCHAR(100) NULL,
                    Priority NVARCHAR(20) NOT NULL DEFAULT 'Routine',
                    Instructions NVARCHAR(500) NULL,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE()
                );`,
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_PrescriptionLabTests_Prescription') CREATE INDEX IX_PrescriptionLabTests_Prescription ON PrescriptionLabTests(PrescriptionId);",

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
