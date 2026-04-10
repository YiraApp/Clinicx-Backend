import { Router } from "express";
import { authRouter } from "./Account/auth.routes.js";
import { rolesRouter } from "./Account/roles.routes.js";
import { sidebarRouter } from "./Common/sidebar.routes.js";
import { organizationRouter } from "./Organizations/organization.routes.js";
import { dashboardRouter } from "./Common/dashboard.routes.js";

const router = Router();

// Routes
router.use("/auth", authRouter);
router.use("/roles", rolesRouter);
router.use("/sidebar", sidebarRouter);
router.use("/organizations", organizationRouter);
router.use("/dashboard", dashboardRouter);

router.get("/status", (req, res) => {
    res.json({ message: "API is working properly" });
});

export default router;
