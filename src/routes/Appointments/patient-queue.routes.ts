import { Router } from "express";
import { patientQueueController } from "../../controllers/Appointments/patient-queue.controller.js";
import { authMiddleware } from "../../middlewares/auth.middleware.js";

const router = Router();

// Get doctor's queue for a specific date
router.get("/", authMiddleware, patientQueueController.getQueue);

// Get hospital-wide queue
router.get("/hospital", authMiddleware, patientQueueController.getHospitalQueue);

// Update patient status in queue
router.patch("/:id/status", authMiddleware, patientQueueController.updateStatus);

export default router;
