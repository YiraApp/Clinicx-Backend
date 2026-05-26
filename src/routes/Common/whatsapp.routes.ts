import { Router } from "express";
import { sendWhatsAppTemplate } from "../../controllers/Common/whatsapp.controller.js";

const router = Router();

router.post("/send-template", sendWhatsAppTemplate);

export default router;
