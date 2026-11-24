import { Router } from "express";
import { ceoDashboardController } from "../../controllers/Common/ceo-dashboard.controller.js";
import { requireYiraSystemAdmin } from "../../middlewares/yira-system-admin.middleware.js";

/** CEO dashboard: platform-wide onboarding, roles, providers, appointments and diagnoses. Yira System Admin only. */
export const ceoDashboardRouter = Router();

ceoDashboardRouter.use(requireYiraSystemAdmin);
ceoDashboardRouter.get("/filters", ceoDashboardController.getFilterOptions.bind(ceoDashboardController));
ceoDashboardRouter.get("/summary", ceoDashboardController.getSummary.bind(ceoDashboardController));
