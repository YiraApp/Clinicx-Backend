import { Router } from "express";
import { defaultOrganizationController } from "../../controllers/Organizations/default-organization.controller.js";

const router = Router();

router.post("/create", (req, res) => defaultOrganizationController.create(req, res));
router.post("/", (req, res) => defaultOrganizationController.create(req, res));
router.put("/:id", (req, res) => defaultOrganizationController.update(req, res));
router.post("/update", (req, res) => defaultOrganizationController.update(req, res));
router.get("/active", (req, res) => defaultOrganizationController.getActive(req, res));
router.get("/", (req, res) => defaultOrganizationController.getAll(req, res));

export const defaultOrganizationRouter = router;
