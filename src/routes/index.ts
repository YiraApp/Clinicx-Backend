import { Router } from "express";
import { authRouter } from "./Account/auth.routes.js";
import { rolesRouter } from "./Account/roles.routes.js";
import { userRouter } from "./Account/user.routes.js";
import { otpRouter } from "./Account/otp.routes.js";
import { sidebarRouter } from "./Common/sidebar.routes.js";
import { organizationRouter } from "./Organizations/organization.routes.js";
import { hospitalRouter } from "./Organizations/hospital.routes.js";
import dashboardRouter from "./Common/dashboard.routes.js";
import mailRouter from "./Common/mail.routes.js";
import { apiLogRouter } from "./Logs/apilog.routes.js";
import masterRouter from "./Masters/master.routes.js";
import hospitalRegistryRouter from "./Organizations/hospital-registry.routes.js";
import { healthcareProviderRouter } from "./Organizations/healthcare-provider.routes.js";
import { patientRegistrationRouter } from "./Organizations/patient-registration.routes.js";
import fileRouter from "./Common/file.routes.js";
import consentRouter from "./Consent/consent.routes.js";
import { appointmentRouter } from "./Appointments/appointment.routes.js";
import verificationRouter from "./Appointments/verification.routes.js";
import patientQueueRouter from "./Appointments/patient-queue.routes.js";
import { clinicalNoteRouter } from "./Appointments/clinical-note.routes.js";
import patientMedicalRecordRouter from "./Appointments/patient-medical-record.routes.js";
import { clinicalSummaryRouter } from "./Appointments/clinical-summary.routes.js";
import patientPrescriptionRouter from "./Appointments/patient-prescription.routes.js";
import { medicalDocumentRouter } from "./Appointments/medical-document.routes.js";

import { snomedRouter } from "../snomed/snomed.routes.js";


const router = Router();

// Routes
router.use("/auth", authRouter);
router.use("/roles", rolesRouter);
router.use("/users", userRouter);
router.use("/Account", otpRouter);
router.use("/sidebar", sidebarRouter);
router.use("/organizations", organizationRouter);
router.use("/hospitals", hospitalRouter);
router.use("/dashboard", dashboardRouter);
router.use("/mail", mailRouter);
router.use("/logs", apiLogRouter);
router.use("/masters", masterRouter);
router.use("/hospital-registry", hospitalRegistryRouter);
router.use("/providers", healthcareProviderRouter);
router.use("/patients", patientRegistrationRouter);
router.use("/files", fileRouter);
router.use("/consent", consentRouter);
router.use("/appointments", appointmentRouter);
router.use("/verification", verificationRouter);
router.use("/queue", patientQueueRouter);
router.use("/clinical-notes", clinicalNoteRouter);
router.use("/medical-records", patientMedicalRecordRouter);
router.use("/clinical-summary", clinicalSummaryRouter);
router.use("/prescriptions", patientPrescriptionRouter);
router.use("/medical-documents", medicalDocumentRouter);
router.use("/snomed", snomedRouter);

router.get("/status", (req: any, res: any) => {
    res.json({ message: "API is working properly" });
});

export default router;
