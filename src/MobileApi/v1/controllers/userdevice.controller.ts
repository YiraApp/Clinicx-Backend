import type { Request, Response } from "express";
import { userDeviceService } from "../services/userdevice.service.js";
import { ApiResponse } from "../../../utils/response.utils.js";

/**
 * Registers or updates a user's mobile device and FCM token for push notifications.
 */
export const registerDeviceToken = async (req: Request, res: Response) => {
    try {
        const { userId, platform, currentVersion, fcmToken, deviceId } = req.body;

        if (!fcmToken) {
            return res.status(400).json({
                status: false,
                message: "FCM token (fcmToken) is required",
                code: "FCM_TOKEN_REQUIRED",
                data: { code: "FCM_TOKEN_REQUIRED" }
            });
        }

        // Retrieve authenticated user's ID if not passed explicitly in request body
        const resolvedUserId = userId || (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id;

        if (!resolvedUserId) {
            return res.status(400).json({
                status: false,
                message: "User ID is required",
                code: "USER_ID_REQUIRED",
                data: { code: "USER_ID_REQUIRED" }
            });
        }

        const device = await userDeviceService.registerDeviceToken(
            resolvedUserId,
            platform,
            currentVersion,
            fcmToken,
            deviceId
        );

        return res.json(ApiResponse.success(device, "Device token registered successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message,
            code: "DEVICE_REGISTRATION_FAILED",
            data: { code: "DEVICE_REGISTRATION_FAILED" }
        });
    }
};
