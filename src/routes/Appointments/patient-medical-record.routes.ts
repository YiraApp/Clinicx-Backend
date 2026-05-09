import { Router } from "express";
import { patientMedicalRecordController } from "../../controllers/Appointments/patient-medical-record.controller.js";

const router = Router();

router.post("/", patientMedicalRecordController.addRecord);
router.get("/patient/:patientId", patientMedicalRecordController.getPatientRecords);
router.patch("/:id", patientMedicalRecordController.updateRecord);
router.delete("/:id", patientMedicalRecordController.deleteRecord);

export default router;
