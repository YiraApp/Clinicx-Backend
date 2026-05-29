import { Router } from "express";
import { paymentController } from "../../controllers/Payments/payment.controller.js";

const paymentRouter = Router();

paymentRouter.post("/create-order", paymentController.createOrder.bind(paymentController));
paymentRouter.post("/verify", paymentController.verify.bind(paymentController));
paymentRouter.post("/webhook", paymentController.webhook.bind(paymentController));
paymentRouter.post("/collect-cash", paymentController.collectManualCash.bind(paymentController));
paymentRouter.post("/send-link", paymentController.sendPaymentLink.bind(paymentController));
paymentRouter.get("/lookup/:transactionId", paymentController.lookupTransaction.bind(paymentController));
paymentRouter.get("/billing", paymentController.getBillingList.bind(paymentController));
paymentRouter.get("/bills", paymentController.getBillsList.bind(paymentController));
paymentRouter.get("/detail/:paymentId", paymentController.getPaymentDetail.bind(paymentController));
paymentRouter.get("/by-appointment/:appointmentId", paymentController.getPaymentByAppointment.bind(paymentController));
paymentRouter.get("/hospital-configuration/:hospitalId", paymentController.getHospitalPaymentConfiguration.bind(paymentController));
paymentRouter.post("/hospital-configuration", paymentController.saveHospitalPaymentConfiguration.bind(paymentController));

export { paymentRouter };


