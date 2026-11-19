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

        // The phone belongs to the signed-in account (the token's user), not to the family
        // profile the app has open: a dependent's notifications reach this phone through
        // their account holder. Only builds that send no token name the user in the body.
        const identity = (req as any).user || {};
        const sentToken = String(req.headers.authorization || "").startsWith("Bearer ");
        if (sentToken && !identity.tokenUserId) {
            // The token was logged out or ran out (the request got through on the old
            // userId fallback). A signed-out phone must not sign up for pushes again.
            return res.status(200).json({
                status: false,
                message: "Session ended; sign in again to get notifications"
            });
        }
        // Opening a family profile gives the app a session of that profile, so the token's
        // user can be a dependent: the phone still belongs to their account holder.
        const resolvedUserId = identity.tokenUserId
            ? await userDeviceService.accountHolderOf(String(identity.tokenUserId))
            : (userId || identity.userId || identity.Id || identity.id);

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

        if (!device) {
            return res.json(ApiResponse.success(null, "Device token registration skipped (user does not exist)"));
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
