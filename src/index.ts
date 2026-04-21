import "reflect-metadata";
import dotenv from "dotenv"; // Restart trigger
import app from "./app.js";
import { initializeDatabase } from "./config/database.js";
import { MigrationService } from "./services/Common/migration.service.js";

dotenv.config();

// Set Global Timezone to IST
process.env.TZ = "Asia/Kolkata";

const port = process.env.PORT || 3000;

const startServer = async () => {
    try {
        await initializeDatabase();
        await MigrationService.ensureLogIndexes();
        app.listen(port, () => {
            console.log(`Server is running on port ${port}`);
        });
    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
};

startServer();
