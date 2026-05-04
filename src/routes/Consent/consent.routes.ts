import { Router } from "express";
import { consentController } from "../../controllers/Consent/consent.controller.js";
import { upload } from "../../middlewares/upload.middleware.js";

const router = Router();

// Create a new consent template (with file upload)
router.post("/templates", upload.single("file"), (req, res) => consentController.createTemplate(req, res));

// Get templates (filtered by hospital or organization)
router.get("/templates", (req, res) => consentController.getTemplates(req, res));

// Update an existing consent template (optionally with file upload)
router.put("/templates/:id", upload.single("file"), (req, res) => consentController.updateTemplate(req, res));

// Send consent to patient
router.post("/send", (req, res) => consentController.sendConsent(req, res));

export default router;
