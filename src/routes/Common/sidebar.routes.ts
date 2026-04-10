import { Router } from "express";
import { getSidebar } from "../../controllers/Common/sidebar.controller.js";

const sidebarRouter = Router();

// Endpoint: GET /api/sidebar?roleId=xxx&orgId=yyy&hospId=zzz
sidebarRouter.get("/", getSidebar);

export { sidebarRouter };
