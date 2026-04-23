import { Router } from "express";
import { hospitalRegistryController } from "../../controllers/Organizations/hospital-registry.controller.js";

const router = Router();

router.get("/:hospitalId", hospitalRegistryController.getRegistry);
router.post("/:hospitalId/update", hospitalRegistryController.updateRegistry);

export default router;
