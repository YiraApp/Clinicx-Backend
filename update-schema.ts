import { AppDataSource, initializeDatabase } from "./src/config/database.js";

async function updateSchema() {
    try {
        await initializeDatabase();
        console.log("Adding new columns to PostVisitDocuments table...");

        const queries = [
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('PostVisitDocuments') AND name = 'SmsSentCount') ALTER TABLE PostVisitDocuments ADD SmsSentCount INT NOT NULL DEFAULT 0;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('PostVisitDocuments') AND name = 'WhatsAppSentCount') ALTER TABLE PostVisitDocuments ADD WhatsAppSentCount INT NOT NULL DEFAULT 0;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('PostVisitDocuments') AND name = 'EmailSentCount') ALTER TABLE PostVisitDocuments ADD EmailSentCount INT NOT NULL DEFAULT 0;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('UserRegistrationLinks') AND name = 'PatientName') ALTER TABLE UserRegistrationLinks ADD PatientName NVARCHAR(100) NULL;"
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
