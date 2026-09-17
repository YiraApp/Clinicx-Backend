import { Router } from "express";
import { patientPrescriptionController } from "../../controllers/Appointments/patient-prescription.controller.js";

import { mobilePrescriptionController } from "../../MobileApi/v1/controllers/provider/prescription.controller.js";

const router = Router();

router.post("/", patientPrescriptionController.addPrescription);
router.get("/:id/pdf", (req, res) => mobilePrescriptionController.getPrescriptionPdf(req, res));
router.put("/:id", patientPrescriptionController.updatePrescription);
router.get("/appointment/:appointmentId", patientPrescriptionController.getPrescriptionsByAppointment);
router.get("/patient/:patientId", patientPrescriptionController.getPatientPrescriptions);
router.delete("/:id", patientPrescriptionController.deletePrescription);

export default router;
