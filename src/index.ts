import "reflect-metadata";
process.env.TZ = "Asia/Kolkata";

import dotenv from "dotenv";
dotenv.config();

import app from "./app.js";
import { initializeDatabase } from "./config/database.js";
import { MigrationService } from "./services/Common/migration.service.js";

const port = process.env.PORT || 8080;

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