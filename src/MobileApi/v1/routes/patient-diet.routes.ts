import { Router } from "express";
import { mobilePatientDietController } from "../controllers/patient-diet.controller.js";
import { dietController } from "../../../controllers/Diet/diet.controller.js";
import { authMiddleware, optionalAuthMiddleware } from "../../../middlewares/auth.middleware.js";

const mobileDietRouter = Router();

// Patient Diet Endpoints (Strict auth required)
mobileDietRouter.get("/active-plan", authMiddleware, mobilePatientDietController.getActivePlan.bind(mobilePatientDietController));
mobileDietRouter.get("/today", authMiddleware, mobilePatientDietController.getTodayMeals.bind(mobilePatientDietController));
mobileDietRouter.get("/plan/:planId", authMiddleware, mobilePatientDietController.getPlanDetails.bind(mobilePatientDietController));

// Doctor Mobile Master Food & Template Endpoints (Optional auth so token attaches if present)
mobileDietRouter.get("/foods", optionalAuthMiddleware, dietController.searchFoods.bind(dietController));
mobileDietRouter.get("/foods/recommendations", optionalAuthMiddleware, dietController.getSlotRecommendations.bind(dietController));
mobileDietRouter.get("/templates", optionalAuthMiddleware, dietController.listTemplates.bind(dietController));
mobileDietRouter.get("/templates/:id", optionalAuthMiddleware, dietController.getTemplateById.bind(dietController));

// Doctor Mobile Prescribe Endpoint (Strict auth required)
mobileDietRouter.post("/assign", authMiddleware, dietController.assignPlan.bind(dietController));

export { mobileDietRouter };

