import { Router } from "express";
import { patientPrescriptionController } from "../../controllers/Appointments/patient-prescription.controller.js";

const router = Router();

router.post("/", patientPrescriptionController.addPrescription);
router.get("/patient/:patientId", patientPrescriptionController.getPatientPrescriptions);
router.delete("/:id", patientPrescriptionController.deletePrescription);

export default router;
