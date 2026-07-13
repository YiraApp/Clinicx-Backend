import { Router } from "express";
import { verificationController } from "../../controllers/Appointments/verification.controller.js";
import { authMiddleware } from "../../middlewares/auth.middleware.js";
import multer from "multer";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// All verification routes are protected
router.use(authMiddleware);

router.get("/:appointmentId", (req, res) => verificationController.getStatus(req, res));
router.post("/:appointmentId/upload", upload.single("file"), (req, res) => verificationController.uploadDocument(req, res));
router.patch("/:appointmentId/status", (req, res) => verificationController.updateStatus(req, res));
router.delete("/:appointmentId/document", (req, res) => verificationController.deleteDocument(req, res));
router.post("/:appointmentId/complete", (req, res) => verificationController.completeCheckin(req, res));

export default router;
