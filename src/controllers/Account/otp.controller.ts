import type { Request, Response } from "express";
import { otpService } from "../../services/Account/otp.service.js";
import { ApiResponse } from "../../utils/response.utils.js";
import { OTPPurpose } from "../../enums/OTPType.enum.js";

/**
 * Global Controller for OTP operations (Email & Mobile).
 */
export class OTPController {
    /**
     * Sends OTP to the provided contact (email or mobile number).
     */
    async sendOTP(req: Request, res: Response) {
        try {
            const { contact, purpose, countryCode } = req.body;

            if (!contact) {
                return res.status(400).json(ApiResponse.error("Contact (email or mobile) is required."));
            }

            const otpPurpose = purpose || OTPPurpose.VERIFICATION;
            const result = await otpService.sendOTP(contact, otpPurpose, countryCode);
            
            return res.json(ApiResponse.success(result, "OTP sent successfully."));
        } catch (error: any) {
            return res.status(error.message.includes("not found") ? 404 : 400).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Resends OTP to the provided contact.
     */
    async resendOTP(req: Request, res: Response) {
        try {
            const { contact, purpose, countryCode } = req.body;

            if (!contact) {
                return res.status(400).json(ApiResponse.error("Contact (email or mobile) is required."));
            }

            const otpPurpose = purpose || OTPPurpose.VERIFICATION;
            const result = await otpService.resendOTP(contact, otpPurpose, countryCode);
            
            return res.json(ApiResponse.success(result, "OTP resent successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Verifies the OTP provided by the user.
     */
    async verifyOTP(req: Request, res: Response) {
        try {
            const { contact, sessionId, otp, purpose, countryCode } = req.body;

            if (!contact || !sessionId || !otp) {
                return res.status(400).json(ApiResponse.error("Contact, sessionId, and OTP are required."));
            }

            const otpPurpose = purpose || OTPPurpose.VERIFICATION;
            const result = await otpService.verifyOTP(contact, sessionId, otp, otpPurpose, countryCode);

            if (!result.success) {
                return res.status(400).json(ApiResponse.error(result.message));
            }

            return res.json(ApiResponse.success(result, result.message));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const otpController = new OTPController();
