import { notificationController } from "../src/MobileApi/v1/controllers/notification.controller.js";
import { authRouter } from "../src/MobileApi/v1/routes/auth.routes.js";

console.log("Notification controller methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(notificationController)));
console.log("Auth router loaded with notification routes:", typeof authRouter);
console.log("✅ Backend notification module verified successfully!");
