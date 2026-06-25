import { Router } from "express";
import { login, sendOTP, verifyLogin, resendOTP, refreshToken, logout, forgotPassword, resetPassword, getRoleDetails } from "../controllers/auth.controller.js";
import { registerDeviceToken } from "../controllers/userdevice.controller.js";
import { authMiddleware } from "../../../middlewares/auth.middleware.js";

const authRouter = Router();

authRouter.post("/login", login);
authRouter.post("/sendotp", sendOTP);
authRouter.post("/verify-login", verifyLogin);
authRouter.post("/resend-otp", resendOTP);
authRouter.post("/refresh", refreshToken);
authRouter.post("/logout", logout);
authRouter.post("/forgot-password", forgotPassword);
authRouter.post("/reset-password", resetPassword);
authRouter.get("/roles/details", getRoleDetails);
authRouter.post("/device-token", authMiddleware, registerDeviceToken);

export { authRouter };
