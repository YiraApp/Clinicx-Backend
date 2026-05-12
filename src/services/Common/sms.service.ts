import { templateRepository } from "../../repositories/Common/template.repository.js";

export class SMSService {
    private username = process.env.SMS_USER!;
    private password = process.env.SMS_PASSWORD!;
    private baseUrl = process.env.SMS_BASE_URL!;
    private type = process.env.SMS_TYPE!;
    private templateId = process.env.SMS_TEMPLATE_ID!;
    private from = process.env.SMS_FROM!;

    /**
     * Replaces placeholders in a string with data from a dictionary.
     * Supports both {{variableName}} and {variableName} formats.
     */
    private replacePlaceholders(content: string, data: Record<string, any>): string {
        if (!content) return "";
        return content.replace(/{{?(\w+)}?}/g, (match, key) => {
            return data[key] !== undefined ? data[key] : match;
        });
    }

    /**
     * Sends a dynamic SMS based on a database template.
     * @param templateCode The unique code for the template.
     * @param to Recipient mobile number.
     * @param data Data for placeholder replacement.
     */
    async sendDynamicSMS(templateCode: string, to: string, data: Record<string, any>): Promise<void> {
        const template = await templateRepository.findByCode(templateCode);

        if (!template) {
            console.error(`SMS Template with code ${templateCode} not found.`);
            // Fallback to a default message if needed, or throw error
            return;
        }

        const message = this.replacePlaceholders(template.Message, data);
        await this.sendSMS(to, message);
    }

    /**
     * Sends a single SMS message.
     * @param to Recipient mobile number (e.g., 919876543210)
     * @param message Message content
     */
    async sendSMS(to: string, message: string): Promise<any> {
        return await this.sendSMSWithCustomTemplate(to, message, this.templateId);
    }

    /**
     * Sends a single SMS message with a specific template ID.
     * @param to Recipient mobile number
     * @param message Message content
     * @param templateId DLT Template ID
     */
    async sendSMSWithCustomTemplate(to: string, message: string, templateId: string): Promise<any> {
        try {
            if (!this.username || !this.password || !this.baseUrl) {
                console.error("[SMS Service] Missing configuration.");
                throw new Error("SMS service configuration is incomplete.");
            }

            // Normalize phone number (remove + if exists)
            const normalizedTo = to.startsWith("+") ? to.slice(1) : to;

            // Sanitize baseUrl (remove trailing ? if exists)
            const cleanBaseUrl = this.baseUrl.endsWith("?") ? this.baseUrl.slice(0, -1) : this.baseUrl;

            // Constructing URL with query parameters
            const url = new URL(cleanBaseUrl);
            url.searchParams.append("username", this.username);
            url.searchParams.append("password", this.password);
            url.searchParams.append("to", normalizedTo);
            url.searchParams.append("from", this.from || "");
            url.searchParams.append("type", this.type);
            url.searchParams.append("template_id", templateId || "");
            url.searchParams.append("msg", message);

            // Create a safe URL for logging (masking password)
            const logUrl = new URL(url.toString());
            logUrl.searchParams.set("password", "****");
            console.log(`[SMS Service] Requesting: ${logUrl.toString()}`);

            const response = await fetch(url.toString(), {
                method: "GET",
            });

            const result = await response.text();
            console.log(`[SMS Service] Response from SMS Striker: ${result}`);

            return result;
        } catch (error: any) {
            console.error(`[SMS Service] Error sending SMS to ${to}:`, error.message);
            throw new Error(`Failed to send SMS: ${error.message}`);
        }
    }

    /**
     * Sends an OTP specific message.
     * @param to Recipient mobile number
     * @param otp OTP code
     */
    async sendOTP(to: string, otp: string): Promise<any> {
        const normalizedTo = to.startsWith("+") ? to.slice(1) : to;
        const isIndia = normalizedTo.startsWith("91");

        if (isIndia) {
            // EXACT message for SMS Striker (DLT requirement)
            const message = `Hello, Your One Time Password (OTP) for Yira AI Mobile Application login authentication is ${otp} - YIRA AI`;
            return await this.sendSMS(to, message);
        } else {
            // International flow using 2Factor.in
            const apiKey = "55b36a1d-a3fe-11eb-80ea-0200cd936042"; // From provided C# logic
            const url = `http://2factor.in/API/V1/${apiKey}/SMS/+${to}/${otp}/Yiralife1`;
            
            console.log(`[SMS Service] Sending International SMS to ${to} via 2Factor...`);
            try {
                const response = await fetch(url, { method: "GET" });
                const result = await response.text();
                console.log(`[SMS Service] 2Factor Response: ${result}`);
                return result;
            } catch (error: any) {
                console.error(`[SMS Service] 2Factor Error:`, error.message);
                throw error;
            }
        }
    }
}

export const smsService = new SMSService();
