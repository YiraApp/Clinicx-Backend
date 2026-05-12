import { Router } from "express";
import { testNewOTPTemplate } from "../../controllers/Common/test-sms-v2.controller.js";

const router = Router();

router.post("/test-otp-v2", testNewOTPTemplate);

export default router;
