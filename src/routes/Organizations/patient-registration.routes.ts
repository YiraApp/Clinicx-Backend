import { Router } from "express";
import { patientRegistrationController } from "../../controllers/Organizations/patient-registration.controller.js";

const patientRegistrationRouter = Router();

patientRegistrationRouter.post("/register", patientRegistrationController.register.bind(patientRegistrationController));
patientRegistrationRouter.get("/", patientRegistrationController.getPatients.bind(patientRegistrationController));
patientRegistrationRouter.post("/send-registration-link", patientRegistrationController.sendRegistrationLink.bind(patientRegistrationController));
patientRegistrationRouter.get("/registration-link/:token", patientRegistrationController.getRegistrationLink.bind(patientRegistrationController));

// New dedicated FrontDesk Patient Management endpoints
patientRegistrationRouter.get("/getpatients", patientRegistrationController.getOrgHospPatients.bind(patientRegistrationController));
patientRegistrationRouter.get("/next-token", patientRegistrationController.getNextToken.bind(patientRegistrationController));
patientRegistrationRouter.get("/quick-check", patientRegistrationController.quickCheck.bind(patientRegistrationController));

export { patientRegistrationRouter };
