import { Router } from "express";
import { patientRegistrationController } from "../../controllers/Organizations/patient-registration.controller.js";
import { hospitalPatientRemovalController } from "../../controllers/Organizations/hospital-patient-removal.controller.js";
import { staffJwtMiddleware } from "../../middlewares/staff-jwt.middleware.js";

const patientRegistrationRouter = Router();

patientRegistrationRouter.post("/register", patientRegistrationController.register.bind(patientRegistrationController));
patientRegistrationRouter.get("/", patientRegistrationController.getPatients.bind(patientRegistrationController));
patientRegistrationRouter.post("/send-registration-link", patientRegistrationController.sendRegistrationLink.bind(patientRegistrationController));
patientRegistrationRouter.get("/registration-link/:token", patientRegistrationController.getRegistrationLink.bind(patientRegistrationController));

// New dedicated FrontDesk Patient Management endpoints
patientRegistrationRouter.get("/getpatients", patientRegistrationController.getOrgHospPatients.bind(patientRegistrationController));
patientRegistrationRouter.get("/next-token", patientRegistrationController.getNextToken.bind(patientRegistrationController));
patientRegistrationRouter.get("/quick-check", patientRegistrationController.quickCheck.bind(patientRegistrationController));

// Front Desk: remove a patient from their hospital (soft delete), the Deleted patients list, restore, and unlink ABHA.
// A signed-in staff token is required; the service checks the user is Front Desk at that hospital.
patientRegistrationRouter.get("/removed", staffJwtMiddleware, hospitalPatientRemovalController.listRemoved);
patientRegistrationRouter.post("/:userId/remove-from-hospital", staffJwtMiddleware, hospitalPatientRemovalController.remove);
patientRegistrationRouter.post("/:userId/restore-to-hospital", staffJwtMiddleware, hospitalPatientRemovalController.restore);
patientRegistrationRouter.post("/:userId/unlink-abha", staffJwtMiddleware, hospitalPatientRemovalController.unlinkAbha);

export { patientRegistrationRouter };
