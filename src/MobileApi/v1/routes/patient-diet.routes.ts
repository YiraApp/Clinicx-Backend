import { Router } from "express";
import { mobilePatientDietController } from "../controllers/patient-diet.controller.js";
import { dietController } from "../../../controllers/Diet/diet.controller.js";
import { authMiddleware, optionalAuthMiddleware } from "../../../middlewares/auth.middleware.js";
import { upload } from "../../../middlewares/upload.middleware.js";

const mobileDietRouter = Router();

// Patient Diet Endpoints (Strict auth required)
mobileDietRouter.get("/active-plan", authMiddleware, mobilePatientDietController.getActivePlan.bind(mobilePatientDietController));
mobileDietRouter.get("/today", authMiddleware, mobilePatientDietController.getTodayMeals.bind(mobilePatientDietController));
mobileDietRouter.get("/plan/:planId", authMiddleware, mobilePatientDietController.getPlanDetails.bind(mobilePatientDietController));
mobileDietRouter.put("/my-plan/:planId", authMiddleware, mobilePatientDietController.updateMyPlan.bind(mobilePatientDietController));
mobileDietRouter.get("/my-plans", authMiddleware, mobilePatientDietController.listMyPlans.bind(mobilePatientDietController));
mobileDietRouter.post("/my-plans", authMiddleware, mobilePatientDietController.createMyPlan.bind(mobilePatientDietController));
mobileDietRouter.delete("/my-plans/:planId", authMiddleware, mobilePatientDietController.deleteMyPlan.bind(mobilePatientDietController));
mobileDietRouter.put("/my-plans/:planId/status", authMiddleware, mobilePatientDietController.setMyPlanStatus.bind(mobilePatientDietController));
mobileDietRouter.get("/my-plans/:planId/logs", authMiddleware, mobilePatientDietController.getMealLogs.bind(mobilePatientDietController));
mobileDietRouter.put("/my-plans/:planId/logs", authMiddleware, mobilePatientDietController.saveMealLog.bind(mobilePatientDietController));
mobileDietRouter.post("/my-plans/:planId/logs/photo", authMiddleware, upload.single("photo"), mobilePatientDietController.uploadMealPhoto.bind(mobilePatientDietController));

// Doctor Mobile Master Food & Template Endpoints (Optional auth so token attaches if present)
mobileDietRouter.get("/foods", optionalAuthMiddleware, dietController.searchFoods.bind(dietController));
mobileDietRouter.get("/foods/recommendations", optionalAuthMiddleware, dietController.getSlotRecommendations.bind(dietController));
mobileDietRouter.get("/templates", optionalAuthMiddleware, dietController.listTemplates.bind(dietController));
mobileDietRouter.get("/templates/:id", optionalAuthMiddleware, dietController.getTemplateById.bind(dietController));
mobileDietRouter.post("/foods", authMiddleware, dietController.createCustomFood.bind(dietController));
mobileDietRouter.post("/templates", authMiddleware, dietController.createTemplate.bind(dietController));
mobileDietRouter.put("/templates/:id", authMiddleware, dietController.updateTemplate.bind(dietController));
mobileDietRouter.delete("/templates/:id", authMiddleware, dietController.deleteTemplate.bind(dietController));
mobileDietRouter.post("/templates/:id/duplicate", authMiddleware, dietController.duplicateTemplate.bind(dietController));

// Doctor Mobile Prescribe Endpoint (Strict auth required)
mobileDietRouter.post("/assign", authMiddleware, dietController.assignPlan.bind(dietController));

// Doctor: a patient's prescribed plans in the doctor's organization (the Diet tab)
mobileDietRouter.get("/patients/:patientId/plans", authMiddleware, dietController.getPatientPlans.bind(dietController));
mobileDietRouter.get("/doctor/plans/:id", authMiddleware, dietController.getPlanDetails.bind(dietController));
mobileDietRouter.put("/doctor/plans/:id", authMiddleware, dietController.updatePlan.bind(dietController));
mobileDietRouter.patch("/doctor/plans/:id/status", authMiddleware, dietController.updatePlanStatus.bind(dietController));

export { mobileDietRouter };

