import { AppDataSource } from "./src/config/database.js";
import dotenv from "dotenv";
dotenv.config();

const runMigration = async () => {
    try {
        await AppDataSource.initialize();
        console.log("DB connected for migration");
        
        const queries = [
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ConsentRequests') AND name = 'SignedPdfUrl') ALTER TABLE ConsentRequests ADD SignedPdfUrl NVARCHAR(MAX) NULL;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ConsentRequests') AND name = 'SignatureImageUrl') ALTER TABLE ConsentRequests ADD SignatureImageUrl NVARCHAR(MAX) NULL;"
        ];

        for (const query of queries) {
            console.log(`Executing: ${query}`);
            await AppDataSource.query(query);
        }
        
        console.log("Migration successful");
        process.exit(0);
    } catch (err) {
        console.error("Migration failed:", err);
        process.exit(1);
    }
};

runMigration();
