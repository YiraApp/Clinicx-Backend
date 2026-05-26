import dotenv from "dotenv";
import { whatsappService } from "../src/services/Common/whatsapp.service.js";

dotenv.config();

const targetPhone = process.env.WHATSAPP_DEFAULT_PHONE || "+919908875796";

(async () => {
  try {
    console.log(`[WhatsApp] Sending sample message to ${targetPhone}`);
    const result = await whatsappService.sendSampleMessage(targetPhone);
    console.log("[WhatsApp] Message sent successfully:", JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("[WhatsApp] Failed to send sample message:", error);
    process.exit(1);
  }
})();
