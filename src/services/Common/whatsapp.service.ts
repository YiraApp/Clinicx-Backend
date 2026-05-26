import dotenv from "dotenv";

dotenv.config();

const WHATSAPP_GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || process.env.WHATSAPP_API_VERSION || "v25.0";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.TRIGGER || process.env.TRIGGEGER;
const WHATSAPP_API_TOKEN = process.env.WHATSAPP_API_TOKEN || process.env.TWEST || process.env.TEST;
const WHATSAPP_DEFAULT_PHONE = process.env.WHATSAPP_DEFAULT_PHONE || process.env.WHATSAPP_TO;
const WHATSAPP_TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || process.env.WHATSAPP_TEMPLATE_ID;
const WHATSAPP_TEMPLATE_LANGUAGE = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en_US";

if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_API_TOKEN) {
  console.warn("[WhatsAppService] WHATSAPP_PHONE_NUMBER_ID/TRIGGER or WHATSAPP_API_TOKEN/TWEST is not configured. WhatsApp Graph API calls will fail until these are set.");
}

const buildGraphApiUrl = () => {
  return `https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
};

export class WhatsAppService {
  private getHeaders() {
    return {
      Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
      "Content-Type": "application/json",
    };
  }

  private validateConfiguration() {
    if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_API_TOKEN) {
      throw new Error("Missing WhatsApp Graph API configuration. Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_API_TOKEN in .env.");
    }
  }

  async sendTextMessage(to: string, message: string): Promise<any> {
    this.validateConfiguration();

    const body = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        preview_url: false,
        body: message,
      },
    };

    const response = await fetch(buildGraphApiUrl(), {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    const responseBody = await response.json();
    if (!response.ok) {
      throw new Error(`WhatsApp Graph API error: ${response.status} ${JSON.stringify(responseBody)}`);
    }

    return responseBody;
  }

  async sendTemplateMessage(
    to: string,
    templateId?: string,
    languageCode?: string,
    components?: any[],
  ): Promise<any> {
    this.validateConfiguration();

    const templateName = templateId || WHATSAPP_TEMPLATE_NAME;
    if (!templateName) {
      throw new Error("Missing WhatsApp template name. Set WHATSAPP_TEMPLATE_NAME or pass templateId in the request.");
    }

    const body = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: {
          code: languageCode || WHATSAPP_TEMPLATE_LANGUAGE,
        },
        ...(components ? { components } : {}),
      },
    };

    const response = await fetch(buildGraphApiUrl(), {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    const responseBody = await response.json();
    if (!response.ok) {
      throw new Error(`WhatsApp Graph API error: ${response.status} ${JSON.stringify(responseBody)}`);
    }

    return responseBody;
  }

  async sendSampleMessage(to?: string): Promise<any> {
    const recipient = to || WHATSAPP_DEFAULT_PHONE;
    if (!recipient) {
      throw new Error("Missing WhatsApp recipient phone number. Set WHATSAPP_DEFAULT_PHONE or pass a number to sendSampleMessage().");
    }

    const message = process.env.WHATSAPP_SAMPLE_MESSAGE || "Hello from ClinicX via WhatsApp Graph API!";
    return this.sendTextMessage(recipient, message);
  }
}

export const whatsappService = new WhatsAppService();
