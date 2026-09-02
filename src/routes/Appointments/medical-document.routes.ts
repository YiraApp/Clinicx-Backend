import { Router } from "express";
import { medicalDocumentController } from "../../controllers/Appointments/medical-document.controller.js";
import { upload } from "../../middlewares/upload.middleware.js";

const medicalDocumentRouter = Router();

medicalDocumentRouter.post("/dental-consultation", medicalDocumentController.sendDentalConsultation.bind(medicalDocumentController));
medicalDocumentRouter.post("/eye-consultation", medicalDocumentController.sendEyeConsultation.bind(medicalDocumentController));
medicalDocumentRouter.post("/home-sample", medicalDocumentController.scheduleHomeSample.bind(medicalDocumentController));
medicalDocumentRouter.post("/share-single", medicalDocumentController.shareSingle.bind(medicalDocumentController));
medicalDocumentRouter.post("/notify-patient", medicalDocumentController.notifyPatient.bind(medicalDocumentController));
medicalDocumentRouter.get("/notifications/:patientId", medicalDocumentController.getNotifications.bind(medicalDocumentController));
medicalDocumentRouter.post("/upload", upload.array("files", 10), medicalDocumentController.upload.bind(medicalDocumentController));
medicalDocumentRouter.get("/patient/:patientId", medicalDocumentController.getByPatient.bind(medicalDocumentController));
medicalDocumentRouter.delete("/:id", medicalDocumentController.delete.bind(medicalDocumentController));

// Public & Token Upload Link Endpoints
medicalDocumentRouter.post("/upload-link/generate/:appointmentId", medicalDocumentController.generateUploadLink.bind(medicalDocumentController));
medicalDocumentRouter.get("/upload-link/info/:token", medicalDocumentController.getUploadLinkInfo.bind(medicalDocumentController));
medicalDocumentRouter.post("/upload-link/upload/:token", upload.array("files", 10), medicalDocumentController.uploadByLink.bind(medicalDocumentController));

export { medicalDocumentRouter };
