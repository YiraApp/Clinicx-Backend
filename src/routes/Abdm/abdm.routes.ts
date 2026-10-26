import { Router } from "express";
import { abhaEnrolmentController } from "../../controllers/Abdm/abha-enrolment.controller.js";
import { staffJwtMiddleware } from "../../middlewares/staff-jwt.middleware.js";

const abdmRouter = Router();

// Every ABDM route spends the clinic's ABDM credentials: signed-in staff only.
abdmRouter.use(staffJwtMiddleware);

abdmRouter.get("/status", abhaEnrolmentController.status.bind(abhaEnrolmentController));

// M1: create or retrieve an ABHA with an Aadhaar OTP
abdmRouter.post("/enrolment/otp", abhaEnrolmentController.requestOtp.bind(abhaEnrolmentController));
abdmRouter.post("/enrolment/otp/resend", abhaEnrolmentController.resendOtp.bind(abhaEnrolmentController));
abdmRouter.post("/enrolment/verify", abhaEnrolmentController.verifyOtp.bind(abhaEnrolmentController));
abdmRouter.post("/enrolment/mobile/otp", abhaEnrolmentController.requestMobileOtp.bind(abhaEnrolmentController));
abdmRouter.post("/enrolment/mobile/verify", abhaEnrolmentController.verifyMobileOtp.bind(abhaEnrolmentController));
abdmRouter.get("/enrolment/address-suggestions", abhaEnrolmentController.addressSuggestions.bind(abhaEnrolmentController));
abdmRouter.post("/enrolment/address", abhaEnrolmentController.createAddress.bind(abhaEnrolmentController));
abdmRouter.get("/enrolment/card", abhaEnrolmentController.card.bind(abhaEnrolmentController));

// Store the verified ABHA on the clinic's patient record
abdmRouter.post("/patients/:userId/abha", abhaEnrolmentController.linkToPatient.bind(abhaEnrolmentController));

export { abdmRouter };
