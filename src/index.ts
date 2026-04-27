import "reflect-metadata";
import { DEFAULTS } from "./config/constants.js";
import app from "./app.js";
import { initializeDatabase } from "./config/database.js";
import { MigrationService } from "./services/Common/migration.service.js";

// Set Global Timezone to IST
process.env.TZ = "Asia/Kolkata";

const port = process.env.PORT || DEFAULTS.PORT;

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
