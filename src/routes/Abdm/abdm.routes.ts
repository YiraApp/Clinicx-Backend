import { Router } from "express";
import { abhaEnrolmentController, abhaShareCallback } from "../../controllers/Abdm/abha-enrolment.controller.js";
import { staffJwtMiddleware, systemAdminOnly } from "../../middlewares/staff-jwt.middleware.js";
import { abdmHiuAccess } from "../../middlewares/abdm-hiu-access.middleware.js";
import { abdmHospitalStaff } from "../../middlewares/abdm-hospital-staff.middleware.js";
import { hiuRouter } from "./hiu.routes.js";
import { abdmHealthRecordController } from "../../controllers/Abdm/abdm-health-record.controller.js";
import { abdmM2Controller } from "../../controllers/Abdm/abdm-m2.controller.js";

const abdmRouter = Router();
const c = abhaEnrolmentController;

// Every ABDM route spends the clinic's ABDM credentials: signed-in staff only.
abdmRouter.use(staffJwtMiddleware);

abdmRouter.get("/status", c.status.bind(c));
// M2: is the bridge, its callback URL and the HIP id ready, as ABDM reports them
abdmRouter.get("/bridge", c.bridge.bind(c));
// Moves every facility's callbacks on this client id: system admins only
abdmRouter.patch("/bridge/url", systemAdminOnly, c.updateBridgeUrl.bind(c));
// Which hospital acts as which HFR facility on that bridge: system admins only
abdmRouter.get("/facilities", systemAdminOnly, c.facilities.bind(c));
abdmRouter.put("/facilities/:hospitalId", systemAdminOnly, c.saveFacility.bind(c));

// M2: the health records (FHIR bundles, by HI type) a care context would share
const hr = abdmHealthRecordController;
abdmRouter.get("/health-records/appointments/:id", hr.appointment.bind(hr));
abdmRouter.get("/health-records/discharge-summaries/:id", hr.dischargeSummary.bind(hr));
abdmRouter.get("/health-records/immunizations/:id", hr.immunization.bind(hr));
abdmRouter.get("/health-records/vitals/:id", hr.vitals.bind(hr));

// M2: a patient's care contexts and their link state; linking and the deep-link SMS. Each acts for
// the hospital in x-hospital-id: only staff with a role there (abdmHospitalStaff, on every M2 patient route).
const m2 = abdmM2Controller;
abdmRouter.get("/patients/:userId/care-contexts", abdmHospitalStaff, m2.careContexts.bind(m2));
abdmRouter.get("/patients/:userId/care-contexts/:reference", abdmHospitalStaff, m2.careContextView.bind(m2));
// M2: the consents ABDM notified this HIP of for the patient, and what was pushed under each (read-only)
abdmRouter.get("/patients/:userId/consents", abdmHospitalStaff, m2.consents.bind(m2));
abdmRouter.post("/patients/:userId/link", abdmHospitalStaff, m2.link.bind(m2));
abdmRouter.post("/patients/:userId/sms-notify", abdmHospitalStaff, m2.smsNotify.bind(m2));

// M1: create or retrieve an ABHA with an Aadhaar OTP
abdmRouter.post("/enrolment/otp", c.requestOtp.bind(c));
abdmRouter.post("/enrolment/otp/resend", c.resendOtp.bind(c));
abdmRouter.post("/enrolment/verify", c.verifyOtp.bind(c));
abdmRouter.post("/enrolment/mobile/otp", c.requestMobileOtp.bind(c));
abdmRouter.post("/enrolment/mobile/verify", c.verifyMobileOtp.bind(c));
abdmRouter.get("/enrolment/address-suggestions", c.addressSuggestions.bind(c));
abdmRouter.post("/enrolment/address", c.createAddress.bind(c));
abdmRouter.get("/enrolment/card", c.card.bind(c));

// M1: verify an existing ABHA by ABHA number, ABHA address or Aadhaar
abdmRouter.post("/login/abha-address/search", c.searchAbhaAddress.bind(c));
abdmRouter.post("/login/otp", c.requestLoginOtp.bind(c));
abdmRouter.post("/login/otp/resend", c.resendLoginOtp.bind(c));
abdmRouter.post("/login/verify", c.verifyLoginOtp.bind(c));
abdmRouter.post("/login/select-account", c.selectAccount.bind(c));

// M1: find a forgotten ABHA by mobile (resend and verify go through /login)
abdmRouter.post("/find/search", c.findByMobile.bind(c));
abdmRouter.post("/find/otp", c.requestFindOtp.bind(c));

// M1: update the mobile on a verified ABHA profile
abdmRouter.post("/profile/mobile/otp", c.requestProfileMobileOtp.bind(c));
abdmRouter.post("/profile/mobile/verify", c.verifyProfileMobileOtp.bind(c));

// Scan and Share: the counter's QR code and today's queue
abdmRouter.get("/share/counter-qr", c.counterQr.bind(c));
abdmRouter.get("/share/queue", c.shareQueue.bind(c));

// Store the verified ABHA on the clinic's patient record
abdmRouter.post("/patients/:userId/abha", c.linkToPatient.bind(c));

// M3: ABDM record requests (HIU), for the roles in ABDM_HIU_ROLE_NAMES at the verified hospital
abdmRouter.use("/hiu", abdmHiuAccess, hiuRouter);

/** ABDM's callbacks to this HIP, mounted at /api/v3/hip before the user-login middleware. */
const abdmCallbackRouter = Router();
abdmCallbackRouter.post("/patient/share", abhaShareCallback);

export { abdmRouter, abdmCallbackRouter };
