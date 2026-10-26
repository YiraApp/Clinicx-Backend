import { Router } from "express";
import { immunizationController } from "../../controllers/Appointments/immunization.controller.js";
import { dischargeSummaryController } from "../../controllers/Appointments/discharge-summary.controller.js";
import { authMiddleware } from "../../middlewares/auth.middleware.js";

/** Immunizations and discharge summaries: the records behind ABDM's ImmunizationRecord and DischargeSummary. */

const immunizationRouter = Router();
const im = immunizationController;
immunizationRouter.post("/", authMiddleware, im.create.bind(im));
immunizationRouter.get("/patient/:patientId", authMiddleware, im.listForPatient.bind(im));
immunizationRouter.patch("/:id", authMiddleware, im.update.bind(im));
immunizationRouter.delete("/:id", authMiddleware, im.delete.bind(im));

const dischargeSummaryRouter = Router();
const ds = dischargeSummaryController;
dischargeSummaryRouter.post("/", authMiddleware, ds.create.bind(ds));
dischargeSummaryRouter.get("/patient/:patientId", authMiddleware, ds.listForPatient.bind(ds));
dischargeSummaryRouter.get("/:id", authMiddleware, ds.get.bind(ds));
dischargeSummaryRouter.patch("/:id", authMiddleware, ds.update.bind(ds));
dischargeSummaryRouter.delete("/:id", authMiddleware, ds.delete.bind(ds));

export { immunizationRouter, dischargeSummaryRouter };
