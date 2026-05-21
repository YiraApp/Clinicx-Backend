import { Router } from "express";
import { testNewOTPTemplate, testConsentSMSTemplate } from "../../controllers/Common/test-sms-v2.controller.js";

const router = Router();

router.post("/test-otp-v2", testNewOTPTemplate);
router.post("/test-consent-sms", testConsentSMSTemplate);

export default router;
