import { Router } from "express";
import { patientDashboardController } from "../../controllers/Appointments/patient-dashboard.controller.js";

const patientDashboardRouter = Router();

patientDashboardRouter.get("/", patientDashboardController.getDashboardDetails.bind(patientDashboardController));
patientDashboardRouter.get("/:userId", patientDashboardController.getDashboardDetails.bind(patientDashboardController));

export default patientDashboardRouter;
