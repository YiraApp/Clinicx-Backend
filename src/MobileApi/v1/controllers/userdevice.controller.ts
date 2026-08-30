import type { Request, Response } from "express";
import { userDeviceService } from "../services/userdevice.service.js";
import { ApiResponse } from "../../../utils/response.utils.js";
import { PlatformType } from "../enums/platform.enum.js";
import { appVersionService } from "../services/app-version.service.js";

/**
 * Registers or updates a user's mobile device and FCM token for push notifications.
 */
export const registerDeviceToken = async (req: Request, res: Response) => {
    try {
        const { userId, platform, currentVersion, fcmToken, deviceId } = req.body || {};

        let normalizedPlatform: PlatformType = PlatformType.ANDROID;
        if (platform) {
            const lowerPlatform = String(platform).toLowerCase();
            if (lowerPlatform === PlatformType.IOS || lowerPlatform.includes("ios") || lowerPlatform.includes("darwin") || lowerPlatform.includes("apple") || lowerPlatform.includes("iphone") || lowerPlatform.includes("ipad")) {
                normalizedPlatform = PlatformType.IOS;
            } else {
                normalizedPlatform = PlatformType.ANDROID;
            }
        }

        const resolvedDeviceId = deviceId || userId || (req as any).user?.userId || `device_${Date.now()}`;

        if (!fcmToken) {
            return res.status(200).json({
                status: false,
                message: "FCM token (fcmToken) is required"
            });
        }

        // Retrieve authenticated user's ID if not passed explicitly in request body
        const resolvedUserId = userId || (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id;

        if (!resolvedUserId) {
            return res.status(200).json({
                status: false,
                message: "User ID is required"
            });
        }

        const device = await userDeviceService.registerDeviceToken(
            resolvedUserId,
            normalizedPlatform,
            currentVersion,
            fcmToken,
            resolvedDeviceId
        );

        const responseData = {
            Id: device.Id,
            UserId: device.UserId,
            FCMToken: device.FCMToken,
            Platform: device.Platform,
            PhysicalDeviceId: device.PhysicalDeviceId,
            CurrentVersion: device.CurrentVersion,
            IsActive: device.IsActive,
            CreatedAt: device.CreatedAt,
            UpdatedAt: device.UpdatedAt
        };

        return res.json(ApiResponse.success(responseData, "Device token registered successfully"));
    } catch (error: any) {
        return res.status(200).json({
            status: false,
            message: error.message
        });
    }
};
