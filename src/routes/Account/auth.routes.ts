import { Router } from "express";
import { login, refreshToken, logout, forgotPassword, resetPassword, validateResetToken } from "../../controllers/Account/auth.controller.js";
import { userController } from "../../controllers/Account/user.controller.js";

const authRouter = Router();

console.log("[DEBUG] AuthRouter file loaded correctly!");

/**
 * Public routes (skip auth).
 */
authRouter.post("/login", login);
authRouter.post("/refresh", refreshToken);
authRouter.post("/register", userController.register.bind(userController));
authRouter.post("/logout", logout);
authRouter.post("/forgot-password", forgotPassword);
authRouter.post("/reset-password", resetPassword);
authRouter.post("/validate-reset-token", validateResetToken);
authRouter.get("/validate-reset-token/:token", validateResetToken);

export { authRouter };
