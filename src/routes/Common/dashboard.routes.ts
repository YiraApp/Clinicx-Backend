import { Router } from "express";
import { dashboardController } from "../../controllers/Common/dashboard.controller.js";

const dashboardRouter = Router();

dashboardRouter.get("/summary", dashboardController.getSummary.bind(dashboardController));

export { dashboardRouter };
