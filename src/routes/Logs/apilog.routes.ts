import { Router } from "express";
import { apiLogController } from "../../controllers/Logs/apilog.controller.js";

const apiLogRouter = Router();

// Log Routes
apiLogRouter.get("/list", apiLogController.getAllLogs);
apiLogRouter.get("/slow", apiLogController.getSlowQueries);
apiLogRouter.get("/search/date", apiLogController.getLogsByDateRange);
apiLogRouter.get("/search/method", apiLogController.getLogsByMethod);
apiLogRouter.get("/search/path", apiLogController.getLogsByPath);
apiLogRouter.get("/details/:id", apiLogController.getLogById);

// Database Stats Routes
apiLogRouter.get("/stats", apiLogController.getDatabaseStats);
apiLogRouter.get("/stats/tables", apiLogController.getTableStats);
apiLogRouter.get("/stats/report", apiLogController.getFullDatabaseReport);

export { apiLogRouter };
