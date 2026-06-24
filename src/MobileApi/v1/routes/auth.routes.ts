import { Router } from "express";
import { login, verifyLogin, resendOTP, refreshToken, logout, forgotPassword, resetPassword } from "../controllers/auth.controller.js";

const authRouter = Router();

authRouter.post("/login", login);
authRouter.post("/verify-login", verifyLogin);
authRouter.post("/resend-otp", resendOTP);
authRouter.post("/refresh", refreshToken);
authRouter.post("/logout", logout);
authRouter.post("/forgot-password", forgotPassword);
authRouter.post("/reset-password", resetPassword);

export { authRouter };
