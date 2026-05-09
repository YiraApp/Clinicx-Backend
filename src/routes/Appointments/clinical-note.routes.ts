import { Router } from "express";
import { clinicalNoteController } from "../../controllers/Appointments/clinical-note.controller.js";
import { authMiddleware } from "../../middlewares/auth.middleware.js";

const clinicalNoteRouter = Router();

clinicalNoteRouter.post("/", authMiddleware, clinicalNoteController.create.bind(clinicalNoteController));
clinicalNoteRouter.get("/patient/:patientId", authMiddleware, clinicalNoteController.getPatientNotes.bind(clinicalNoteController));
clinicalNoteRouter.get("/appointment/:appointmentId", authMiddleware, clinicalNoteController.getAppointmentNotes.bind(clinicalNoteController));
clinicalNoteRouter.patch("/:id", authMiddleware, clinicalNoteController.update.bind(clinicalNoteController));
clinicalNoteRouter.delete("/:id", authMiddleware, clinicalNoteController.delete.bind(clinicalNoteController));

export { clinicalNoteRouter };
