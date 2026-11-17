import { Router } from "express";
import { hospitalLabTestController } from "../../controllers/Organizations/hospital-lab-test.controller.js";
import { authMiddleware } from "../../middlewares/auth.middleware.js";

const hospitalLabTestRouter = Router();

hospitalLabTestRouter.get("/:hospitalId/lab-tests", authMiddleware, hospitalLabTestController.list.bind(hospitalLabTestController));
hospitalLabTestRouter.post("/:hospitalId/lab-tests", authMiddleware, hospitalLabTestController.create.bind(hospitalLabTestController));
hospitalLabTestRouter.put("/:hospitalId/lab-tests/:id", authMiddleware, hospitalLabTestController.update.bind(hospitalLabTestController));
hospitalLabTestRouter.delete("/:hospitalId/lab-tests/:id", authMiddleware, hospitalLabTestController.remove.bind(hospitalLabTestController));

export { hospitalLabTestRouter };
