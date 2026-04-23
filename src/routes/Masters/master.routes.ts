import { Router } from "express";
import { masterController } from "../../controllers/Masters/master.controller.js";

const router = Router();

router.get("/specialties", masterController.getSpecialties);
router.get("/sub-specialties", masterController.getSubSpecialties);
router.get("/departments", masterController.getDepartments);

export default router;
