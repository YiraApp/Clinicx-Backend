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
            "IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[MeetingRedirections]') AND type in (N'U')) BEGIN CREATE TABLE [dbo].[MeetingRedirections] ( [Id] BIGINT IDENTITY(1,1) PRIMARY KEY, [UrlId] NVARCHAR(100) NOT NULL UNIQUE, [AppointmentId] INT NOT NULL, [PatientId] UNIQUEIDENTIFIER NOT NULL, [OrganizationId] INT NOT NULL, [HospitalId] INT NOT NULL, [DoctorId] UNIQUEIDENTIFIER NOT NULL, [MeetingUrl] NVARCHAR(500) NOT NULL, [AppointmentDate] DATE NOT NULL, [StartTime] NVARCHAR(50) NULL, [IsActive] BIT NOT NULL DEFAULT 1, [AccessCount] INT NOT NULL DEFAULT 0, [LastAccessedAt] DATETIME NULL, [CreatedAt] DATETIME NOT NULL DEFAULT GETDATE() ); END"
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
