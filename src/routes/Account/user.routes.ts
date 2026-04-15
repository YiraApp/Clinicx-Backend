import { Router } from "express";
import { userController } from "../../controllers/Account/user.controller.js";
import { otpController } from "../../controllers/Account/otp.controller.js";

const userRouter = Router();

/**
 * Get all users with advanced filtering, pagination, and sorting.
 */
userRouter.get("/getUsers", userController.getUsers.bind(userController));

/**
 * Global OTP sending endpoint - works for both email and mobile
 * Body: { contact: string (email or phone), purpose?: string (default: VERIFICATION) }
 */
userRouter.post("/sendOTP", otpController.sendOTP.bind(otpController));

/**
 * Global OTP verification endpoint - works for both email and mobile
 * Body: { contact: string, sessionId: string, otp: string, purpose?: string }
 */
userRouter.post("/verifyOTP", otpController.verifyOTP.bind(otpController));

export { userRouter };
