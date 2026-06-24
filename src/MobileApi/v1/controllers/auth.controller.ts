import type { Request, Response } from "express";
import { mobileAuthService } from "../services/mobile-auth.service.js";
import { authService } from "../../../services/Account/auth.service.js";
import { ApiResponse } from "../../../utils/response.utils.js";

/**
 * Handles mobile user login requests.
 * Email: authenticates with password directly.
 * Phone: dispatches OTP for login verification without password.
 */
export const login = async (req: Request, res: Response) => {
    try {
        const { identity, password, countryCode, isResend, resend } = req.body;
        if (!identity) {
            return res.status(400).json(ApiResponse.error("Identity is required"));
        }

        const deviceInfo = req.headers["x-device-info"] as string;
        const ipAddress = req.headers["x-ip-address"] as string;

        const isResendFlag = isResend === true || resend === true;
        const result = await mobileAuthService.login(identity, password, countryCode, deviceInfo, ipAddress, isResendFlag);
        const successMessage = result.otpSent 
            ? (isResendFlag ? "OTP resent successfully" : "OTP sent successfully") 
            : "Login successful";
        return res.json(ApiResponse.success(result, successMessage));
    } catch (error: any) {
        return res.status(401).json(ApiResponse.error(error.message));
    }
};

/**
 * Handles resending OTP for mobile logins.
 */
export const resendOTP = async (req: Request, res: Response) => {
    try {
        const { contact, countryCode } = req.body;
        if (!contact) {
            return res.status(400).json(ApiResponse.error("Contact (phone number) is required"));
        }

        const result = await mobileAuthService.resendOTP(contact, countryCode);
        return res.json(ApiResponse.success(result, "OTP resent successfully"));
    } catch (error: any) {
        return res.status(400).json(ApiResponse.error(error.message));
    }
};

/**
 * Verifies mobile OTP and issues authentication tokens.
 */
export const verifyLogin = async (req: Request, res: Response) => {
    try {
        const { contact, sessionId, otp, countryCode } = req.body;
        if (!contact || !sessionId || !otp) {
            return res.status(400).json(ApiResponse.error("Contact, sessionId, and OTP are required"));
        }

        const deviceInfo = req.headers["x-device-info"] as string;
        const ipAddress = req.headers["x-ip-address"] as string;

        const result = await mobileAuthService.verifyAndLogin(contact, sessionId, otp, countryCode, deviceInfo, ipAddress);
        return res.json(ApiResponse.success(result, "Login successful"));
    } catch (error: any) {
        return res.status(401).json(ApiResponse.error(error.message));
    }
};

/**
 * Handles mobile token refresh requests.
 */
export const refreshToken = async (req: Request, res: Response) => {
    try {
        const { refreshToken } = req.body;
        const result = await mobileAuthService.refreshToken(refreshToken);
        return res.json(ApiResponse.success(result, "Token refreshed successfully"));
    } catch (error: any) {
        return res.status(401).json(ApiResponse.error(error.message));
    }
};

/**
 * Handles mobile user logout.
 */
export const logout = async (req: Request, res: Response) => {
    try {
        const { refreshToken } = req.body;
        await authService.logout(refreshToken);
        return res.status(200).json(ApiResponse.success(null, "Logged out successfully"));
    } catch (error: any) {
        return res.status(400).json(ApiResponse.error(error.message));
    }
};

/**
 * Handles mobile forgot password requests.
 */
export const forgotPassword = async (req: Request, res: Response) => {
    try {
        const { identity } = req.body;
        if (!identity) {
            return res.status(400).json(ApiResponse.error("Email or phone number is required"));
        }
        const result = await authService.forgotPassword(identity);
        return res.json(ApiResponse.success(result, result.message));
    } catch (error: any) {
        return res.status(404).json(ApiResponse.error(error.message));
    }
};

/**
 * Handles mobile password reset using a token.
 */
export const resetPassword = async (req: Request, res: Response) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword) {
            return res.status(400).json(ApiResponse.error("Token and new password are required"));
        }
        if (newPassword.length < 6) {
            return res.status(400).json(ApiResponse.error("Password must be at least 6 characters"));
        }
        const result = await authService.resetPassword(token, newPassword);
        return res.json(ApiResponse.success(result, result.message));
    } catch (error: any) {
        return res.status(400).json(ApiResponse.error(error.message));
    }
};
