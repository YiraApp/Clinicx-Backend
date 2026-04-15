import { Router } from "express";
import { otpController } from "../../controllers/Account/otp.controller.js";
import { authMiddleware } from "../../middlewares/auth.middleware.js";

const otpRouter = Router();

/**
 * OTP Routes
 * These are grouped under /Account in the main index.ts
 */

// We protect these routes because the user must be authenticated (even if not verified) to trigger verification
otpRouter.post("/sendOTP", authMiddleware, otpController.sendOTP.bind(otpController));
otpRouter.post("/verifyOTP", authMiddleware, otpController.verifyOTP.bind(otpController));

export { otpRouter };
