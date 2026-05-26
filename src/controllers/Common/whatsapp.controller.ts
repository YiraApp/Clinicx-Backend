import { Request, Response } from "express";
import { whatsappService } from "../../services/Common/whatsapp.service.js";

export const sendWhatsAppTemplate = async (req: Request, res: Response) => {
  try {
    const { to, templateId, templateName, languageCode, components } = req.body;

    if (!to) {
      return res.status(400).json({ success: false, error: "Recipient phone number (to) is required." });
    }

    const resolvedTemplateName = templateName || templateId || process.env.WHATSAPP_TEMPLATE_NAME || process.env.WHATSAPP_TEMPLATE_ID;
    if (!resolvedTemplateName) {
      return res.status(400).json({ success: false, error: "Template name or templateId is required." });
    }

    const result = await whatsappService.sendTemplateMessage(to, resolvedTemplateName, languageCode, components);
    res.status(200).json({ success: true, to, template: resolvedTemplateName, result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || "Failed to send WhatsApp template message." });
  }
};
