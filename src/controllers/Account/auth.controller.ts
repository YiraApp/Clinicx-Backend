import type { Request, Response } from "express";
import { authService } from "../../services/Account/auth.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

/**
 * Handles user login requests.
 */
export const login = async (req: Request, res: Response) => {
    try {
        const { identity, password, roleId } = req.body;
        const deviceInfo = req.headers["x-device-info"] as string;
        const ipAddress = req.headers["x-ip-address"] as string;

        const result = await authService.login(identity, password, roleId, deviceInfo, ipAddress);
        return res.json(ApiResponse.success(result, "Login successful"));
    } catch (error: any) {
        return res.status(401).json(ApiResponse.error(error.message));
    }
};

/**
 * Handles token refresh requests.
 */
export const refreshToken = async (req: Request, res: Response) => {
    try {
        const { refreshToken } = req.body;
        const result = await authService.refreshToken(refreshToken);
        return res.json(ApiResponse.success(result, "Token refreshed successfully"));
    } catch (error: any) {
        return res.status(401).json(ApiResponse.error(error.message));
    }
};

/**
 * Handles user logout.
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
 * Handles forgot password requests.
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

export const validateResetToken = async (req: Request, res: Response) => {
    try {
        const token = (req.params.token || req.query.token || req.body.token) as string;
        if (!token) {
            return res.status(400).json(ApiResponse.error("Token is required"));
        }
        const result = await authService.validateResetToken(token);
        return res.json(ApiResponse.success(result, "Reset token is valid"));
    } catch (error: any) {
        return res.status(400).json(ApiResponse.error(error.message));
    }
};

/**
 * Handles password reset using a token.
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
