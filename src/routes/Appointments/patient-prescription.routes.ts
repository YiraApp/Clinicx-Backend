import { Router } from "express";
import { patientPrescriptionController } from "../../controllers/Appointments/patient-prescription.controller.js";

const router = Router();

router.post("/", patientPrescriptionController.addPrescription);
router.put("/:id", patientPrescriptionController.updatePrescription);
router.get("/appointment/:appointmentId", patientPrescriptionController.getPrescriptionsByAppointment);
router.get("/patient/:patientId", patientPrescriptionController.getPatientPrescriptions);
router.delete("/:id", patientPrescriptionController.deletePrescription);

export default router;
