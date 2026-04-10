import { Router } from "express";
import { organizationController } from "../../controllers/Organizations/organization.controller.js";

const organizationRouter = Router();

organizationRouter.post("/createorg", organizationController.create.bind(organizationController));
organizationRouter.post("/updateorg", organizationController.update.bind(organizationController));
organizationRouter.get("/getAllOrganizations", organizationController.getAll.bind(organizationController));

export { organizationRouter };
