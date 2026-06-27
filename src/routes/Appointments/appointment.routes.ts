import { Router } from "express";
import { appointmentController } from "../../controllers/Appointments/appointment.controller.js";

const appointmentRouter = Router();

appointmentRouter.post("/book", appointmentController.book.bind(appointmentController));
appointmentRouter.get("/", appointmentController.getAppointments.bind(appointmentController));
appointmentRouter.get("/doctor/:doctorId", appointmentController.getDoctorAppointments.bind(appointmentController));
appointmentRouter.get("/hospital", appointmentController.getHospitalAppointments.bind(appointmentController));
appointmentRouter.get("/patient/:userId", appointmentController.getPatientAppointments.bind(appointmentController));
appointmentRouter.get("/patient/:userId/hospitals", appointmentController.getPatientHospitalSummary.bind(appointmentController));
appointmentRouter.get("/patient/:userId/hospital/:hospitalId", appointmentController.getPatientAppointmentsByHospital.bind(appointmentController));
appointmentRouter.patch("/:id/status", appointmentController.updateStatus.bind(appointmentController));
appointmentRouter.post("/:id/cancel", appointmentController.cancel.bind(appointmentController));
appointmentRouter.post("/instant-meeting", appointmentController.createInstantMeeting.bind(appointmentController));

export { appointmentRouter };
