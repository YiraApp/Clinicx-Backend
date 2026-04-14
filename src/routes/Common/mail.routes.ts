import { Router } from "express";
import { mailController } from "../../controllers/Common/mail.controller.js";

const router = Router();

/**
 * @route POST /api/mail/test
 * @desc Sends a test email
 * @access Private (or Public for testing)
 */
router.post("/test", mailController.sendTestEmail);
router.post("/test-welcome", mailController.sendWelcomeTestEmail);

export default router;
