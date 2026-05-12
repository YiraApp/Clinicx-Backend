import { Router } from "express";
import { medicalDocumentController } from "../../controllers/Appointments/medical-document.controller.js";
import { upload } from "../../middlewares/upload.middleware.js";

const medicalDocumentRouter = Router();

medicalDocumentRouter.post("/upload", upload.array("files", 10), medicalDocumentController.upload.bind(medicalDocumentController));
medicalDocumentRouter.get("/patient/:patientId", medicalDocumentController.getByPatient.bind(medicalDocumentController));
medicalDocumentRouter.delete("/:id", medicalDocumentController.delete.bind(medicalDocumentController));

export { medicalDocumentRouter };
