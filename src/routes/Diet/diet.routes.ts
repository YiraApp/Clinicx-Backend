import { Router } from "express";
import { dietController } from "../../controllers/Diet/diet.controller.js";
import { authMiddleware } from "../../middlewares/auth.middleware.js";

const dietRouter = Router();

// Master Foods
dietRouter.get("/foods", dietController.searchFoods.bind(dietController));
dietRouter.get("/foods/categories", dietController.getCategories.bind(dietController));
dietRouter.get("/foods/recommendations", dietController.getSlotRecommendations.bind(dietController));
dietRouter.post("/foods", authMiddleware, dietController.createCustomFood.bind(dietController));
dietRouter.put("/foods/:id", authMiddleware, dietController.updateCustomFood.bind(dietController));
dietRouter.delete("/foods/:id", authMiddleware, dietController.deleteCustomFood.bind(dietController));

// Templates
dietRouter.get("/templates", dietController.listTemplates.bind(dietController));
dietRouter.get("/templates/:id", dietController.getTemplateById.bind(dietController));
dietRouter.post("/templates", authMiddleware, dietController.createTemplate.bind(dietController));
dietRouter.put("/templates/:id", authMiddleware, dietController.updateTemplate.bind(dietController));
dietRouter.delete("/templates/:id", authMiddleware, dietController.deleteTemplate.bind(dietController));
dietRouter.post("/templates/:id/duplicate", authMiddleware, dietController.duplicateTemplate.bind(dietController));

// Patient Diet Plans
dietRouter.post("/plans", authMiddleware, dietController.assignPlan.bind(dietController));
dietRouter.get("/plans/patient/:patientId", authMiddleware, dietController.getPatientPlans.bind(dietController));
dietRouter.get("/plans/:id", authMiddleware, dietController.getPlanDetails.bind(dietController));
dietRouter.put("/plans/:id", authMiddleware, dietController.updatePlan.bind(dietController));
dietRouter.patch("/plans/:id/status", authMiddleware, dietController.updatePlanStatus.bind(dietController));

export { dietRouter };
