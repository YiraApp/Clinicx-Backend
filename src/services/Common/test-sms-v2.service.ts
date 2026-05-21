import { SMSService } from "./sms.service.js";

export class TestSMSV2Service {
    private smsService = new SMSService();

    async testNewOTPTemplate(to: string, otp: string): Promise<any> {
        // EXACT message for SMS Striker (DLT requirement)
        // Variation 1: Original text provided by user with "Hello, your" prefix
        // Variation 3: Using the known working message structure from other IDs
        const message = `Hello, Your One Time Password (OTP) for Yira AI Mobile Application login authentication is ${otp} - YIRA AI`;
        
        // Variation 2 (Commented out): If Variation 1 fails, we might need to check for hidden dots or different wording.
        // const message = `Hello, Your One Time Password (OTP) for Yira AI Mobile Application login authentication is ${otp} - YIRA AI`;
        
        const templateId = "1707177856235480750";

        console.log(`[Test SMS V2] Sending with Template ID: ${templateId}`);
        console.log(`[Test SMS V2] Message: ${message}`);

        // We need to temporarily override the templateId for this test or pass it to sendSMS
        // For testing, I'll modify sendSMS to accept an optional templateId
        return await (this.smsService as any).sendSMSWithCustomTemplate(to, message, templateId);
    }
    async testConsentSMSTemplate(to: string, patientName: string, hospitalName: string, consentLink: string): Promise<any> {
        const templateId = "1707177867188357697";
        const message = `Hello ${patientName}, please review and sign the hospital consent form for your treatment/procedure at ${hospitalName} using the link below: ${consentLink}`;

        console.log(`[Test Consent SMS] Sending with Template ID: ${templateId}`);
        console.log(`[Test Consent SMS] To: ${to}`);
        console.log(`[Test Consent SMS] Message: ${message}`);

        return await (this.smsService as any).sendSMSWithCustomTemplate(to, message, templateId);
    }
}

export const testSMSV2Service = new TestSMSV2Service();
