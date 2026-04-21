import { Router } from "express";
import { dashboardController } from "../../controllers/Common/dashboard.controller.js";

const dashboardRouter = Router();

dashboardRouter.get("/summary", dashboardController.getSummary.bind(dashboardController));
dashboardRouter.get("/admin", dashboardController.getAdminDashboardData.bind(dashboardController));
dashboardRouter.get("/analytics", dashboardController.getAnalytics.bind(dashboardController));

export default dashboardRouter;
