import { Router } from "express";
import { patientSummaryController } from "../../controllers/Appointments/patient-summary.controller.js";

const patientSummaryRouter = Router();

patientSummaryRouter.get("/", patientSummaryController.getSummary.bind(patientSummaryController));

export default patientSummaryRouter;
