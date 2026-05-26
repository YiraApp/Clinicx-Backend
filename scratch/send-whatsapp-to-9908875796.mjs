import axios from "axios";

const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "EAAOFjAeid40BRn9ZAxGUrk35JWmdOZA1l8RF3PA4c1qFwd6y5SuaQDrSv6DlFTq2GIVMKsOJihZCUBL0ofq0ygD7NMZBqf0tOQprJsvZBDliSZA7vb4wkjZCqjQqGVAcVrGEwJhC5F34XUtJqc0IBtIcb5xRUiaZC3mlp1CxkKnZB0wZB7bBbnthNa7Plt8S9YRxebkgZDZD";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID || "1131780976675591";
const TO_NUMBER = process.env.WHATSAPP_TO_NUMBER || "919908875796";

async function sendTemplate() {
  const response = await axios.post(
    `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: TO_NUMBER,
      type: "template",
      template: {
        name: "medical_patient_documents",
        language: { code: "en" },
        components: [
          {
            type: "header",
            parameters: [{ type: "text", text: "KIMS hospitals" }]
          },
          {
            type: "body",
            parameters: [
              { type: "text", text: "Teja" },
              { type: "text", text: "KIMS hospitals" }
            ]
          },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [
              { type: "text", text: "8f5cf93e-ff5e-458b-ad80-1d48d74aee92" }
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
}

sendTemplate().catch(err => {
  console.error("❌ Error sending WhatsApp template:", err.response?.data || err.message);
  process.exit(1);
});
