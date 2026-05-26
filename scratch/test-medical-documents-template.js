import axios from "axios";

// User will pass these via environment variables
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "YOUR_ACCESS_TOKEN";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID || "1131780976675591";

async function sendMedicalDocumentsTemplate() {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: "916303012453",
        type: "template",
        template: {
          name: "medical_patient_documents",
          language: {
            code: "en"
          },
          components: [
            {
              type: "header",
              parameters: [
                {
                  type: "text",
                  text: "KIMS hospitals"
                }
              ]
            },
            {
              type: "body",
              parameters: [
                {
                  type: "text",
                  text: "Teja"
                },
                {
                  type: "text",
                  text: "KIMS hospitals"
                }
              ]
            },
            {
              type: "button",
              sub_type: "url",
              index: "0",
              parameters: [
                {
                  type: "text",
                  text: "8f5cf93e-ff5e-458b-ad80-1d48d74aee92"
                }
              ]
            }
          ]
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
    console.log("✅ WhatsApp template message sent successfully");
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error(
      "❌ Error sending WhatsApp template:",
      error.response?.data || error.message
    );
  }
}

sendMedicalDocumentsTemplate();
