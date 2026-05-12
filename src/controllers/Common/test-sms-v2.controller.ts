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
