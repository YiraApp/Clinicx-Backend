import { Router } from "express";
import { abhaEnrolmentController, abhaShareCallback } from "../../controllers/Abdm/abha-enrolment.controller.js";
import { staffJwtMiddleware, systemAdminOnly } from "../../middlewares/staff-jwt.middleware.js";
import { abdmHiuAccess } from "../../middlewares/abdm-hiu-access.middleware.js";
import { hiuRouter } from "./hiu.routes.js";

const abdmRouter = Router();
const c = abhaEnrolmentController;

// Every ABDM route spends the clinic's ABDM credentials: signed-in staff only.
abdmRouter.use(staffJwtMiddleware);

abdmRouter.get("/status", c.status.bind(c));
// M2: is the bridge, its callback URL and the HIP id ready, as ABDM reports them
abdmRouter.get("/bridge", c.bridge.bind(c));
// Moves every facility's callbacks on this client id: system admins only
abdmRouter.patch("/bridge/url", systemAdminOnly, c.updateBridgeUrl.bind(c));

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
