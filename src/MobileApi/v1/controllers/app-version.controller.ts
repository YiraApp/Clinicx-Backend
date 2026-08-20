import type { Request, Response } from "express";
import { appVersionService } from "../services/app-version.service.js";
import { ApiResponse } from "../../../utils/response.utils.js";
import { PlatformType } from "../enums/platform.enum.js";
import { userDeviceRepository } from "../repositories/userdevice.repository.js";

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
        const { platform, version, minVersion, forceUpdate, url, maintenance, logout } = req.body;

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
        const isMaintenance = maintenance === true || maintenance === "true" || maintenance === 1;
        const isLogout = logout === true || logout === "true" || logout === 1;

        const newVersion = await appVersionService.createNewVersion(
            normalizedPlatform,
            version,
            minVersion,
            isForceUpdate,
            url,
            isMaintenance,
            isLogout
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

/**
 * Checks the app version status and device FCM token activation status.
 */
export const getVersionAndTokenStatus = async (req: Request, res: Response) => {
    try {
        const { platform, currentVersion, deviceId, userId } = req.body || {};

        if (!platform) {
            return res.status(400).json({
                status: false,
                message: "Platform is required in request body",
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
        const latest = await appVersionService.getLatestAppVersion(normalizedPlatform);

        let versionStatus = true;
        let updateType = "normal";
        let tokenStatus = false;

        const isMaintenance = process.env.MAINTENANCE_MODE === "true" || (latest && (latest.Maintenance || latest.Version === "maintenance" || latest.Url === "maintenance"));
        const isLogout = latest && (latest.Logout || latest.Version === "logout" || latest.Url === "logout");

        if (isMaintenance) {
            versionStatus = false;
            updateType = "maintenance";
        } else if (isLogout) {
            versionStatus = false;
            updateType = "logout";
        } else if (resolvedCurrentVersion && latest) {
            const versionCheck = await appVersionService.checkVersion(normalizedPlatform, String(resolvedCurrentVersion));
            if (versionCheck) {
                if (versionCheck.forceUpdate) {
                    versionStatus = false;
                    updateType = "force";
                } else if (versionCheck.updateAvailable) {
                    versionStatus = false;
                    updateType = "soft";
                }
            }
        }

        if (deviceId) {
            const dev = await userDeviceRepository.findByPhysicalDeviceId(String(deviceId));
            if (dev && dev.IsActive) {
                if (userId) {
                    if (dev.UserId === userId) {
                        tokenStatus = true;
                    }
                } else {
                    tokenStatus = true;
                }
            }
        }


        const defaultPlayStoreLink = "https://play.google.com/store/apps/details?id=ai.yira.clinicx";
        const defaultAppStoreLink = "https://apps.apple.com/app/yira-clinx/id6741477759";
        const storeLink = latest?.Url || (normalizedPlatform === PlatformType.ANDROID ? defaultPlayStoreLink : defaultAppStoreLink);

        const responseData = {
            versionStatus,
            updateType,
            tokenStatus,
            playStoreLink: normalizedPlatform === PlatformType.ANDROID ? storeLink : defaultPlayStoreLink,
            appStoreLink: normalizedPlatform === PlatformType.IOS ? storeLink : defaultAppStoreLink,
            url: storeLink,
            latestVersion: latest?.Version || "1.0.0",
            currentVersion: resolvedCurrentVersion,
            forceUpdate: updateType === "force"
        };

        return res.json(ApiResponse.success(responseData, "App version and token status fetched successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message,
            code: "VERSION_TOKEN_STATUS_FAILED",
            data: { code: "VERSION_TOKEN_STATUS_FAILED" }
        });
    }
};
