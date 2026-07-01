import { Router } from "express";
import { login, sendOTP, verifyLogin, resendOTP, refreshToken, logout, forgotPassword, resetPassword, getRoleDetails, updateLatestContext, getUserData } from "../controllers/auth.controller.js";
import { registerDeviceToken } from "../controllers/userdevice.controller.js";
import { getLatestAppVersion, registerNewAppVersion, getVersionAndTokenStatus } from "../controllers/app-version.controller.js";
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
authRouter.get("/user-data", authMiddleware, getUserData);
authRouter.post("/latest-context", authMiddleware, updateLatestContext);
authRouter.post("/device-token", authMiddleware, registerDeviceToken);
authRouter.get("/app-version", getLatestAppVersion);
authRouter.post("/app-version/status", getVersionAndTokenStatus);
authRouter.post("/app-version", authMiddleware, registerNewAppVersion);

export { authRouter };
