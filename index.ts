
import "reflect-metadata";
import dotenv from "dotenv";
if (process.env.NODE_ENV !== "production") {
    dotenv.config();
}

import app from "./src/app.js";
import { initializeDatabase } from "./src/config/database.js";
import { MigrationService } from "./src/services/Common/migration.service.js";


const port = process.env.PORT || 8080;

process.env.TZ = "Asia/Kolkata";

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