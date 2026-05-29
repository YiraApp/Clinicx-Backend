import { Router } from "express";
import { clinicalSummaryController } from "../../controllers/Appointments/clinical-summary.controller.js";
import { postVisitController } from "../../controllers/Appointments/post-visit.controller.js";
import multer from "multer";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Get raw clinical summary data for generation
router.get("/:appointmentId", clinicalSummaryController.getSummary);

// Share existing blob URL documents directly (no PDF upload needed)
router.post("/:appointmentId/share-direct", postVisitController.shareDirect.bind(postVisitController));

// Upload generated PDFs and generate share link
router.post("/:appointmentId/upload", upload.array("documents"), postVisitController.uploadDocuments);

// Publicly accessible route to fetch documents via share token
router.get("/share/:token", postVisitController.getSharedSummary);

export const clinicalSummaryRouter = router;
