import { AppDataSource, initializeDatabase } from "./src/config/database.js";

async function updateSchema() {
    try {
        await initializeDatabase();
        console.log("Adding new columns to PostVisitDocuments table...");

        const queries = [
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('PostVisitDocuments') AND name = 'SmsSentCount') ALTER TABLE PostVisitDocuments ADD SmsSentCount INT NOT NULL DEFAULT 0;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('PostVisitDocuments') AND name = 'WhatsAppSentCount') ALTER TABLE PostVisitDocuments ADD WhatsAppSentCount INT NOT NULL DEFAULT 0;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('PostVisitDocuments') AND name = 'EmailSentCount') ALTER TABLE PostVisitDocuments ADD EmailSentCount INT NOT NULL DEFAULT 0;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('UserRegistrationLinks') AND name = 'PatientName') ALTER TABLE UserRegistrationLinks ADD PatientName NVARCHAR(100) NULL;",
            "IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[MeetingRedirections]') AND type in (N'U')) BEGIN CREATE TABLE [dbo].[MeetingRedirections] ( [Id] BIGINT IDENTITY(1,1) PRIMARY KEY, [UrlId] NVARCHAR(100) NOT NULL UNIQUE, [AppointmentId] INT NOT NULL, [PatientId] UNIQUEIDENTIFIER NOT NULL, [OrganizationId] INT NOT NULL, [HospitalId] INT NOT NULL, [DoctorId] UNIQUEIDENTIFIER NOT NULL, [MeetingUrl] NVARCHAR(500) NOT NULL, [AppointmentDate] DATE NOT NULL, [StartTime] NVARCHAR(50) NULL, [IsActive] BIT NOT NULL DEFAULT 1, [AccessCount] INT NOT NULL DEFAULT 0, [LastAccessedAt] DATETIME NULL, [CreatedAt] DATETIME NOT NULL DEFAULT GETDATE() ); END",
            "IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[UserDevices]') AND type in (N'U')) BEGIN CREATE TABLE [dbo].[UserDevices] ( [Id] INT IDENTITY(1,1) PRIMARY KEY, [UserId] UNIQUEIDENTIFIER NOT NULL, [FCMToken] NVARCHAR(MAX) NOT NULL, [Platform] VARCHAR(50) NULL, [PhysicalDeviceId] VARCHAR(255) NULL, [CurrentVersion] VARCHAR(50) NULL, [IsActive] BIT NOT NULL DEFAULT 1, [CreatedAt] DATETIME NOT NULL DEFAULT GETDATE(), [UpdatedAt] DATETIME NULL, CONSTRAINT [FK_UserDevices_Users] FOREIGN KEY ([UserId]) REFERENCES [dbo].[Users] ([Id]) ON DELETE CASCADE ); END",
            "IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[AppVersions]') AND type in (N'U')) BEGIN CREATE TABLE [dbo].[AppVersions] ( [Id] INT IDENTITY(1,1) PRIMARY KEY, [Platform] VARCHAR(50) NOT NULL, [Version] VARCHAR(50) NOT NULL, [MinVersion] VARCHAR(50) NOT NULL, [ForceUpdate] BIT NOT NULL DEFAULT 0, [Url] NVARCHAR(MAX) NULL, [IsLatest] BIT NOT NULL DEFAULT 1, [IsDeleted] BIT NOT NULL DEFAULT 0, [CreatedAt] DATETIME NOT NULL DEFAULT GETDATE(), [UpdatedAt] DATETIME NULL ); END",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'RecentOrgId') ALTER TABLE Users ADD RecentOrgId INT NULL;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'RecentHospitalId') ALTER TABLE Users ADD RecentHospitalId INT NULL;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'RecentRoleId') ALTER TABLE Users ADD RecentRoleId UNIQUEIDENTIFIER NULL;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'LatestOrgId') ALTER TABLE Users ADD LatestOrgId INT NULL;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'LatestHospitalId') ALTER TABLE Users ADD LatestHospitalId INT NULL;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'LatestRoleId') ALTER TABLE Users ADD LatestRoleId UNIQUEIDENTIFIER NULL;",
            "IF EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'RecentOrgId') ALTER TABLE Users DROP COLUMN RecentOrgId;",
            "IF EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'RecentHospitalId') ALTER TABLE Users DROP COLUMN RecentHospitalId;",
            "IF EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'RecentRoleId') ALTER TABLE Users DROP COLUMN RecentRoleId;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('AppointmentBillItems') AND name = 'AppointmentId') ALTER TABLE AppointmentBillItems ADD AppointmentId INT NULL;"
        ];

        for (const query of queries) {
            console.log(`Executing: ${query}`);
            await AppDataSource.query(query);
        }

        console.log("✅ Schema updated successfully");
        process.exit(0);
    } catch (error) {
        console.error("❌ Schema update failed:", error);
        process.exit(1);
    }
}

updateSchema();
