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
