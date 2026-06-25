import type { Request, Response } from "express";
import { appVersionService } from "../services/app-version.service.js";
import { ApiResponse } from "../../../utils/response.utils.js";
import { PlatformType } from "../enums/platform.enum.js";

/**
 * Retrieves the latest active app version settings for the requested platform.
 */
export const getLatestAppVersion = async (req: Request, res: Response) => {
    try {
        const { platform, currentVersion } = req.query;

        if (!platform) {
            return res.status(400).json({
                status: false,
                message: "Platform query parameter (platform) is required",
                code: "PLATFORM_REQUIRED",
                data: { code: "PLATFORM_REQUIRED" }
            });
        }

        const lowerPlatform = String(platform).toLowerCase();
        let normalizedPlatform: PlatformType;
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

        const resolvedCurrentVersion = currentVersion || req.headers["x-app-version"];

        if (resolvedCurrentVersion) {
            const versionCheck = await appVersionService.checkVersion(normalizedPlatform, String(resolvedCurrentVersion));
            if (!versionCheck) {
                return res.status(404).json({
                    status: false,
                    message: `No active version settings found for platform: ${platform}`,
                    code: "VERSION_NOT_FOUND",
                    data: { code: "VERSION_NOT_FOUND" }
                });
            }
            return res.json(ApiResponse.success(versionCheck, "App version check completed"));
        } else {
            const appVersion = await appVersionService.getLatestAppVersion(normalizedPlatform);
            if (!appVersion) {
                return res.status(404).json({
                    status: false,
                    message: `No active version settings found for platform: ${platform}`,
                    code: "VERSION_NOT_FOUND",
                    data: { code: "VERSION_NOT_FOUND" }
                });
            }
            return res.json(ApiResponse.success(appVersion, "Latest app version fetched successfully"));
        }
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message,
            code: "VERSION_FETCH_FAILED",
            data: { code: "VERSION_FETCH_FAILED" }
        });
    }
};

/**
 * Registers or updates a new live version (admin route).
 */
export const registerNewAppVersion = async (req: Request, res: Response) => {
    try {
        const { platform, version, minVersion, forceUpdate, url } = req.body;

        if (!platform || !version || !minVersion) {
            return res.status(400).json({
                status: false,
                message: "Platform, version, and minVersion are required",
                code: "MISSING_FIELDS",
                data: { code: "MISSING_FIELDS" }
            });
        }

        const lowerPlatform = String(platform).toLowerCase();
        let normalizedPlatform: PlatformType;
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

        const isForceUpdate = forceUpdate === true || forceUpdate === "true" || forceUpdate === 1;

        const newVersion = await appVersionService.createNewVersion(
            normalizedPlatform,
            version,
            minVersion,
            isForceUpdate,
            url
        );

        return res.json(ApiResponse.success(newVersion, "New app version registered successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message,
            code: "VERSION_REGISTRATION_FAILED",
            data: { code: "VERSION_REGISTRATION_FAILED" }
        });
    }
};
