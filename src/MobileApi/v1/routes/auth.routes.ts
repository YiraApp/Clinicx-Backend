import { Router } from "express";
import { login, sendOTP, verifyLogin, resendOTP, refreshToken, logout, forgotPassword, resetPassword, getRoleDetails, updateLatestContext, getUserData, verifyOTP, changePassword, sendSignupOtp, register } from "../controllers/auth.controller.js";
import { registerDeviceToken } from "../controllers/userdevice.controller.js";
import { getLatestAppVersion, registerNewAppVersion, getVersionAndTokenStatus } from "../controllers/app-version.controller.js";
import { getProviderDashboard, getClinicalData, getPatientsList, getPatientsFilters, getPatientOverview, getPatientProfile, getProviderProfile, updateProviderProfile, uploadProviderProfilePhoto, getSidebarMenu, toggleFavoritePatient, getFavoritePatientsList } from "../controllers/provider/dashboard.controller.js";
import { getAppointmentDashboard, bookAppointment, updateAppointmentStatus, getMobileDoctorSlots, deployMobileDoctorSlots, blockMobileDoctorSlot, getTreatmentPlans, getPatientAppointments, getPatientAccountsByPhone, addDependentPatient, getHospitalDoctors } from "../controllers/provider/appointment.controller.js";
import { mobileSnomedController } from "../controllers/snomed.controller.js";
import { mobileClinicalNoteController } from "../controllers/provider/clinical-note.controller.js";
import { mobileMedicalRecordController } from "../controllers/provider/medical-record.controller.js";
import { mobilePrescriptionController } from "../controllers/provider/prescription.controller.js";
import { mobileMedicalDocumentController } from "../controllers/provider/medical-document.controller.js";
import { patientAccessConsentController } from "../controllers/consent/patient-access-consent.controller.js";
import { notificationController } from "../controllers/notification.controller.js";
import { hospitalController } from "../../../controllers/Organizations/hospital.controller.js";
import { mobileDoctorSuggestionController } from "../controllers/provider/doctor-suggestion.controller.js";
import { upload } from "../../../middlewares/upload.middleware.js";
import { authMiddleware } from "../../../middlewares/auth.middleware.js";

const authRouter = Router();

authRouter.post("/login", login);
authRouter.post("/register", register);
authRouter.post("/signup-otp", sendSignupOtp);
authRouter.post("/sendotp", sendOTP);
authRouter.post("/verify-login", verifyLogin);
authRouter.post("/resend-otp", resendOTP);
authRouter.post("/refresh", refreshToken);
authRouter.post("/logout", logout);
authRouter.post("/forgot_password", forgotPassword);
authRouter.post("/verify_otp", verifyOTP);
authRouter.post("/change_password", changePassword);
authRouter.post("/reset_password", resetPassword);
authRouter.get("/roles/details", getRoleDetails);
authRouter.get("/user-data", authMiddleware, getUserData);
authRouter.get("/hospitals", authMiddleware, (req, res) => hospitalController.getAll(req, res));
authRouter.get("/hospitals/all", authMiddleware, (req, res) => hospitalController.getAll(req, res));
authRouter.post("/dashboard", authMiddleware, getProviderDashboard);
authRouter.post("/appointment-dashboard", authMiddleware, getAppointmentDashboard);
authRouter.post("/book-appointment", authMiddleware, bookAppointment);
authRouter.post("/update-appointment-status", authMiddleware, updateAppointmentStatus);
authRouter.post("/doctor-slots", authMiddleware, getMobileDoctorSlots);
authRouter.post("/doctor-slots/deploy", authMiddleware, deployMobileDoctorSlots);
authRouter.post("/doctor-slots/block", authMiddleware, blockMobileDoctorSlot);
authRouter.get("/hospital-doctors", authMiddleware, getHospitalDoctors);
authRouter.post("/hospital-doctors", authMiddleware, getHospitalDoctors);
authRouter.get("/treatment-plans", authMiddleware, getTreatmentPlans);
authRouter.post("/treatment-plans", authMiddleware, getTreatmentPlans);
authRouter.post("/patient-appointments", authMiddleware, getPatientAppointments);
authRouter.post("/patients/accounts-by-phone", authMiddleware, getPatientAccountsByPhone);
authRouter.get("/patients/accounts-by-phone", authMiddleware, getPatientAccountsByPhone);
authRouter.post("/patients/add-dependent", authMiddleware, addDependentPatient);
authRouter.post("/clinical-data", authMiddleware, getClinicalData);
authRouter.post("/patients", authMiddleware, getPatientsList);
authRouter.get("/patients/filters", authMiddleware, getPatientsFilters);
authRouter.post("/favorite-patients/toggle", authMiddleware, toggleFavoritePatient);
authRouter.post("/favorite-patients/list", authMiddleware, getFavoritePatientsList);
authRouter.post("/patient/overview", authMiddleware, getPatientOverview);
authRouter.post("/patient/details", authMiddleware, getPatientProfile);
authRouter.post("/provider/profile", authMiddleware, getProviderProfile);
authRouter.post("/provider/profile/update", authMiddleware, updateProviderProfile);
authRouter.post("/provider/profile/upload-photo", authMiddleware, upload.single("photo"), uploadProviderProfilePhoto);
authRouter.post("/sidebar", authMiddleware, getSidebarMenu);
authRouter.post("/latest-context", authMiddleware, updateLatestContext);
authRouter.post("/device-token", authMiddleware, registerDeviceToken);
authRouter.get("/app-version", getLatestAppVersion);
authRouter.post("/app-version/status", getVersionAndTokenStatus);
authRouter.post("/app-version", authMiddleware, registerNewAppVersion);

// SNOMED CT Search
authRouter.get("/snomed/search", authMiddleware, (req, res) => mobileSnomedController.search(req, res));

// Clinical Notes
authRouter.get("/clinical-notes/patient/:patientId", authMiddleware, (req, res) => mobileClinicalNoteController.getPatientNotes(req, res));
authRouter.post("/clinical-notes", authMiddleware, (req, res) => mobileClinicalNoteController.addNote(req, res));
authRouter.put("/clinical-notes/:id", authMiddleware, (req, res) => mobileClinicalNoteController.updateNote(req, res));
authRouter.delete("/clinical-notes/:id", authMiddleware, (req, res) => mobileClinicalNoteController.deleteNote(req, res));

// Medical Records
authRouter.get("/medical-records/patient/:patientId", authMiddleware, (req, res) => mobileMedicalRecordController.getPatientRecords(req, res));
authRouter.post("/medical-records", authMiddleware, (req, res) => mobileMedicalRecordController.addRecord(req, res));
authRouter.put("/medical-records/:id", authMiddleware, (req, res) => mobileMedicalRecordController.updateRecord(req, res));
authRouter.delete("/medical-records/:id", authMiddleware, (req, res) => mobileMedicalRecordController.deleteRecord(req, res));

// Prescriptions
authRouter.get("/prescriptions/patient/:patientId", authMiddleware, (req, res) => mobilePrescriptionController.getPatientPrescriptions(req, res));
authRouter.post("/prescriptions", authMiddleware, (req, res) => mobilePrescriptionController.addPrescription(req, res));
authRouter.put("/prescriptions/:id", authMiddleware, (req, res) => mobilePrescriptionController.updatePrescription(req, res));
authRouter.delete("/prescriptions/:id", authMiddleware, (req, res) => mobilePrescriptionController.deletePrescription(req, res));

// Medical Documents
authRouter.get("/medical-documents/patient/:patientId", authMiddleware, (req, res) => mobileMedicalDocumentController.getPatientDocuments(req, res));
authRouter.post("/medical-documents", authMiddleware, upload.array("files"), (req, res) => mobileMedicalDocumentController.uploadDocuments(req, res));
authRouter.delete("/medical-documents/:id", authMiddleware, (req, res) => mobileMedicalDocumentController.deleteDocument(req, res));

// Patient Medical Record Access Consents & Doctor QR Linking
authRouter.post("/doctor/connect-patient", authMiddleware, (req, res) => patientAccessConsentController.connectDoctorPatient(req, res));
authRouter.post("/patient-access/connect-by-qr", authMiddleware, (req, res) => patientAccessConsentController.connectDoctorPatient(req, res));
authRouter.post("/patient-access/request", authMiddleware, (req, res) => patientAccessConsentController.requestAccess(req, res));
authRouter.get("/patient-access/check", authMiddleware, (req, res) => patientAccessConsentController.checkAccess(req, res));
authRouter.get("/patient-access/patient-consents", authMiddleware, (req, res) => patientAccessConsentController.getPatientConsents(req, res));
authRouter.post("/patient-access/respond", authMiddleware, (req, res) => patientAccessConsentController.respondToConsent(req, res));

// In-App Notifications & Alerts
authRouter.get("/notifications", authMiddleware, notificationController.getNotifications);
authRouter.post("/notifications/test", authMiddleware, notificationController.sendTestNotification);
authRouter.post("/notifications/:id/read", authMiddleware, notificationController.markAsRead);
authRouter.post("/notifications/mark-all-read", authMiddleware, notificationController.markAllAsRead);

// Doctor Suggestions
authRouter.get("/doctor-suggestions/patient/:patientId", authMiddleware, (req, res) => mobileDoctorSuggestionController.getPatientSuggestions(req, res));
authRouter.post("/doctor-suggestions", authMiddleware, upload.any(), (req, res) => mobileDoctorSuggestionController.addSuggestion(req, res));
authRouter.delete("/doctor-suggestions/:id", authMiddleware, (req, res) => mobileDoctorSuggestionController.deleteSuggestion(req, res));

export { authRouter };
