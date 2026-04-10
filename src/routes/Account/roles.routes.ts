import { Router } from "express";
import { getRoles } from "../../controllers/Account/role.controller.js";

const rolesRouter = Router();

console.log("[DEBUG] RolesRouter file loaded correctly!");

/**
 * Public route to get all active roles (used in Login).
 */
rolesRouter.get("/getRoles", getRoles);

export { rolesRouter };
