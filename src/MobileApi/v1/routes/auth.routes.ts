import { Router } from "express";
import { login, sendOTP, verifyLogin, resendOTP, refreshToken, logout, forgotPassword, resetPassword, getRoleDetails, updateLatestContext, getUserData, verifyOTP, changePassword } from "../controllers/auth.controller.js";
import { registerDeviceToken } from "../controllers/userdevice.controller.js";
import { getLatestAppVersion, registerNewAppVersion, getVersionAndTokenStatus } from "../controllers/app-version.controller.js";
import { getProviderDashboard, getClinicalData, getPatientsList, getPatientsFilters, getPatientOverview, getPatientProfile, getSidebarMenu } from "../controllers/provider/dashboard.controller.js";
import { authMiddleware } from "../../../middlewares/auth.middleware.js";

const authRouter = Router();

authRouter.post("/login", login);
authRouter.post("/sendotp", sendOTP);
authRouter.post("/verify-login", verifyLogin);
authRouter.post("/resend-otp", resendOTP);
authRouter.post("/refresh", refreshToken);
authRouter.post("/logout", logout);
authRouter.post("/forgot_password", forgotPassword);
authRouter.post("/verify_otp", verifyOTP);
authRouter.post("/change_password", changePassword);
authRouter.post("/reset_password", resetPassword);
authRouter.get("/roles/details", getRoleDetails);
authRouter.get("/user-data", authMiddleware, getUserData);
authRouter.post("/dashboard", authMiddleware, getProviderDashboard);
authRouter.post("/clinical-data", authMiddleware, getClinicalData);
authRouter.post("/patients", authMiddleware, getPatientsList);
authRouter.get("/patients/filters", authMiddleware, getPatientsFilters);
authRouter.post("/patient/overview", authMiddleware, getPatientOverview);
authRouter.post("/patient/details", authMiddleware, getPatientProfile);
authRouter.post("/sidebar", authMiddleware, getSidebarMenu);
authRouter.post("/latest-context", authMiddleware, updateLatestContext);
authRouter.post("/device-token", authMiddleware, registerDeviceToken);
authRouter.get("/app-version", getLatestAppVersion);
authRouter.post("/app-version/status", getVersionAndTokenStatus);
authRouter.post("/app-version", authMiddleware, registerNewAppVersion);

export { authRouter };
