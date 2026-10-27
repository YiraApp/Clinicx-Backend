import { Router } from "express";
import { immunizationController } from "../../controllers/Appointments/immunization.controller.js";
import { dischargeSummaryController } from "../../controllers/Appointments/discharge-summary.controller.js";
import { diagnosticReportController } from "../../controllers/Appointments/diagnostic-report.controller.js";
import { wellnessRecordController } from "../../controllers/Appointments/wellness-record.controller.js";
import { authMiddleware } from "../../middlewares/auth.middleware.js";

/**
 * Immunizations, discharge summaries, diagnostic reports and wellness records: the records behind
 * ABDM's ImmunizationRecord, DischargeSummary, DiagnosticReport and WellnessRecord.
 */

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

const diagnosticReportRouter = Router();
const dr = diagnosticReportController;
diagnosticReportRouter.post("/", authMiddleware, dr.create.bind(dr));
diagnosticReportRouter.get("/patient/:patientId", authMiddleware, dr.listForPatient.bind(dr));
diagnosticReportRouter.get("/:id", authMiddleware, dr.get.bind(dr));
diagnosticReportRouter.patch("/:id", authMiddleware, dr.update.bind(dr));
diagnosticReportRouter.delete("/:id", authMiddleware, dr.delete.bind(dr));

const wellnessRecordRouter = Router();
const wr = wellnessRecordController;
wellnessRecordRouter.post("/", authMiddleware, wr.create.bind(wr));
wellnessRecordRouter.get("/patient/:patientId", authMiddleware, wr.listForPatient.bind(wr));
wellnessRecordRouter.patch("/:id", authMiddleware, wr.update.bind(wr));
wellnessRecordRouter.delete("/:id", authMiddleware, wr.delete.bind(wr));

export { immunizationRouter, dischargeSummaryRouter, diagnosticReportRouter, wellnessRecordRouter };
