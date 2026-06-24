import type { Request, Response } from "express";
import { mobileAuthService } from "../services/mobile-auth.service.js";
import { authService } from "../../../services/Account/auth.service.js";
import { ApiResponse } from "../../../utils/response.utils.js";

/**
 * Handles mobile user login requests.
 * Email: authenticates with password directly.
 * Mobile: verifies OTP using sessionId and password (which is the OTP code).
 */
export const login = async (req: Request, res: Response) => {
    try {
        const { identity, password, loginType, type, sessionId, countryCode } = req.body;
        if (!identity) {
            return res.status(400).json(ApiResponse.error("Identity is required"));
        }

        const deviceInfo = req.headers["x-device-info"] as string;
        const ipAddress = req.headers["x-ip-address"] as string;

        const resolvedType = loginType || type || ( /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity) ? "email" : "mobile" );

        const result = await mobileAuthService.login(
            identity,
            password,
            resolvedType,
            sessionId,
            countryCode,
            deviceInfo,
            ipAddress
        );

        return res.json(ApiResponse.success(result, "Login successful! Welcome back."));
    } catch (error: any) {
        return res.status(401).json(ApiResponse.error(error.message));
    }
};

/**
 * Sends OTP to a mobile phone user if they exist and are active with Patient/Provider roles.
 * Supports resending via optional `isResend` / `resend` body flag.
 */
export const sendOTP = async (req: Request, res: Response) => {
    const { identity, countryCode, isResend, resend } = req.body;
    const isResendFlag = isResend === true || resend === true;
    try {
        if (!identity) {
            return res.status(400).json(ApiResponse.error("Identity (phone number) is required"));
        }

        const result = await mobileAuthService.sendOTP(identity, countryCode, isResendFlag);
        const successMessage = isResendFlag ? "OTP resent successfully!" : "OTP sent successfully!";
        return res.json(ApiResponse.success(result, successMessage));
    } catch (error: any) {
        if (error.message === "User not registered") {
            return res.status(404).json(ApiResponse.error(error.message));
        }
        if (error.message.includes("Access denied")) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
        const errorMsg = isResendFlag 
            ? "Could not resend OTP. Please try again." 
            : "Failed to send OTP. Please try again later.";
        return res.status(400).json(ApiResponse.error(errorMsg));
    }
};

/**
 * Handles resending OTP for mobile logins (legacy endpoint wrapper).
 */
export const resendOTP = async (req: Request, res: Response) => {
    try {
        const { contact, countryCode } = req.body;
        if (!contact) {
            return res.status(400).json(ApiResponse.error("Contact (phone number) is required"));
        }

        const result = await mobileAuthService.sendOTP(contact, countryCode, true);
        return res.json(ApiResponse.success(result, "OTP resent successfully!"));
    } catch (error: any) {
        return res.status(400).json(ApiResponse.error("Could not resend OTP. Please try again."));
    }
};

/**
 * Verifies mobile OTP and issues authentication tokens (legacy endpoint wrapper).
 */
export const verifyLogin = async (req: Request, res: Response) => {
    try {
        const { contact, sessionId, otp, countryCode } = req.body;
        if (!contact || !sessionId || !otp) {
            return res.status(400).json(ApiResponse.error("Contact, sessionId, and OTP are required"));
        }

        const deviceInfo = req.headers["x-device-info"] as string;
        const ipAddress = req.headers["x-ip-address"] as string;

        const result = await mobileAuthService.login(
            contact,
            otp,
            "mobile",
            sessionId,
            countryCode,
            deviceInfo,
            ipAddress
        );
        return res.json(ApiResponse.success(result, "Login successful! Welcome back."));
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

/**
 * Fetches organizations and hospitals associated with a user's role.
 */
export const getRoleDetails = async (req: Request, res: Response) => {
    try {
        const { userId, roleId } = req.query;

        if (!userId) {
            return res.status(400).json(ApiResponse.error("userId is required"));
        }
        if (!roleId) {
            return res.status(400).json(ApiResponse.error("roleId is required"));
        }

        const result = await mobileAuthService.getUserOrganizationHospitals(
            String(userId),
            String(roleId)
        );

        return res.json(ApiResponse.success(result, "Organizations and hospitals fetched successfully"));
    } catch (error: any) {
        return res.status(400).json(ApiResponse.error(error.message));
    }
};
