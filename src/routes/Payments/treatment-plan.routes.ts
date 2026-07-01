import { Router } from "express";
import { treatmentPlanController } from "../../controllers/Payments/treatment-plan.controller.js";

const treatmentPlanRouter = Router();

treatmentPlanRouter.get("/", treatmentPlanController.getPlans.bind(treatmentPlanController));
treatmentPlanRouter.post("/", treatmentPlanController.createPlan.bind(treatmentPlanController));
treatmentPlanRouter.put("/:planId", treatmentPlanController.updatePlan.bind(treatmentPlanController));
treatmentPlanRouter.delete("/:planId", treatmentPlanController.deletePlan.bind(treatmentPlanController));

export { treatmentPlanRouter };
