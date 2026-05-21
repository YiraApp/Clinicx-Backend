import { Request, Response } from "express";
import { testSMSV2Service } from "../../services/Common/test-sms-v2.service.js";

export const testNewOTPTemplate = async (req: Request, res: Response) => {
    try {
        const { mobile, otp } = req.body;

        if (!mobile || !otp) {
            return res.status(400).json({ error: "Mobile and OTP are required" });
        }

        const result = await testSMSV2Service.testNewOTPTemplate(mobile, otp);
        res.status(200).json({ success: true, result });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const testConsentSMSTemplate = async (req: Request, res: Response) => {
    try {
        const { mobile, patientName, hospitalName, consentLink } = req.body;

        if (!mobile) {
            return res.status(400).json({ error: "mobile is required" });
        }

        const to = mobile.startsWith("91") ? mobile : `91${mobile}`;
        const name = patientName || "Patient";
        const hospital = hospitalName || "ClinicX Hospital";
        const link = consentLink || "https://clinicx.yira.ai/sign-consent";

        const result = await testSMSV2Service.testConsentSMSTemplate(to, name, hospital, link);
        res.status(200).json({ success: true, to, message: `Consent SMS sent to ${to}`, result });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
};
