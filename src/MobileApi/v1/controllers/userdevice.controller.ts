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
        const { userId, platform, currentVersion, fcmToken, deviceId } = req.body;

        let normalizedPlatform: PlatformType | undefined;
        if (platform) {
            const lowerPlatform = String(platform).toLowerCase();
            if (lowerPlatform === PlatformType.ANDROID) {
                normalizedPlatform = PlatformType.ANDROID;
            } else if (lowerPlatform === PlatformType.IOS) {
                normalizedPlatform = PlatformType.IOS;
            } else {
                return res.status(400).json({
                    status: false,
                    message: "Invalid platform. Platform must be 'android' or 'ios'",
                    code: "INVALID_PLATFORM",
                    data: { code: "INVALID_PLATFORM" }
                });
            }
        }

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
            normalizedPlatform,
            currentVersion,
            fcmToken,
            deviceId
        );

        let updateAvailable = false;
        let forceUpdate = false;

        if (normalizedPlatform && currentVersion) {
            try {
                const versionCheck = await appVersionService.checkVersion(normalizedPlatform, String(currentVersion));
                if (versionCheck) {
                    updateAvailable = versionCheck.updateAvailable;
                    forceUpdate = versionCheck.forceUpdate;
                }
            } catch (error) {
                // Silently fall back to false if version check fails
            }
        }

        const responseData = {
            Id: device.Id,
            UserId: device.UserId,
            FCMToken: device.FCMToken,
            Platform: device.Platform,
            PhysicalDeviceId: device.PhysicalDeviceId,
            CurrentVersion: device.CurrentVersion,
            IsActive: device.IsActive,
            CreatedAt: device.CreatedAt,
            UpdatedAt: device.UpdatedAt,
            updateAvailable,
            forceUpdate
        };

        return res.json(ApiResponse.success(responseData, "Device token registered successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message,
            code: "DEVICE_REGISTRATION_FAILED",
            data: { code: "DEVICE_REGISTRATION_FAILED" }
        });
    }
};
