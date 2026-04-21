import { Router } from "express";
import { authRouter } from "./Account/auth.routes.js";
import { rolesRouter } from "./Account/roles.routes.js";
import { userRouter } from "./Account/user.routes.js";
import { otpRouter } from "./Account/otp.routes.js";
import { sidebarRouter } from "./Common/sidebar.routes.js";
import { organizationRouter } from "./Organizations/organization.routes.js";
import { hospitalRouter } from "./Organizations/hospital.routes.js";
import dashboardRouter from "./Common/dashboard.routes.js";
import mailRouter from "./Common/mail.routes.js";
import { apiLogRouter } from "./Logs/apilog.routes.js";

const router = Router();

// Routes
router.use("/auth", authRouter);
router.use("/roles", rolesRouter);
router.use("/users", userRouter);
router.use("/Account", otpRouter);
router.use("/sidebar", sidebarRouter);
router.use("/organizations", organizationRouter);
router.use("/hospitals", hospitalRouter);
router.use("/dashboard", dashboardRouter);
router.use("/mail", mailRouter);
router.use("/logs", apiLogRouter);

router.get("/status", (req, res) => {
    res.json({ message: "API is working properly" });
});

export default router;
