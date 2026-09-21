import { userDeviceRepository } from "../repositories/userdevice.repository.js";
import { UserDevice } from "../../../models/Account/userdevice.model.js";
import { PlatformType } from "../enums/platform.enum.js";
import { AppDataSource } from "../../../config/database.js";
import { User } from "../../../models/Account/user.model.js";

export class UserDeviceService {
    async registerDeviceToken(
        userId: string,
        platform: PlatformType | undefined,
        currentVersion: string | undefined,
        fcmToken: string,
        deviceId: string
    ): Promise<UserDevice | null> {
        if (!deviceId) {
            throw new Error("Device ID is required");
        }
        if (!fcmToken) {
            throw new Error("FCM token is required");
        }

        // Validate that user exists in database to prevent FK_UserDevices_Users foreign key violation
        if (userId) {
            const userRepo = AppDataSource.getRepository(User);
            const user = await userRepo.findOne({
                where: { Id: userId }
            });
            if (!user) {
                console.warn(`[UserDeviceService] User ID ${userId} does not exist in database. Skipping device token registration.`);
                return null;
            }
        } else {
            return null;
        }

        let device = await userDeviceRepository.findByPhysicalDeviceId(deviceId);

        if (device) {
            // Transfer ownership to current user or update details
            device.UserId = userId;
            device.FCMToken = fcmToken;
            if (platform) device.Platform = platform;
            if (currentVersion) device.CurrentVersion = currentVersion;
            device.IsActive = true;
            device.UpdatedAt = new Date();
        } else {
            device = new UserDevice();
            device.UserId = userId;
            device.FCMToken = fcmToken;
            device.Platform = platform;
            device.PhysicalDeviceId = deviceId;
            device.CurrentVersion = currentVersion;
            device.IsActive = true;
            device.CreatedAt = new Date();
        }

        return await userDeviceRepository.saveDevice(device);
    }

    async deactivateDeviceToken(fcmToken: string): Promise<void> {
        if (!fcmToken) {
            throw new Error("FCM token is required for deactivation");
        }
        await userDeviceRepository.deactivateToken(fcmToken);
    }

    async deactivateDevices(
        userId: string,
        one: boolean,
        fcmToken?: string,
        deviceId?: string
    ): Promise<void> {
        if (one) {
            await userDeviceRepository.deactivateSpecificDevice(userId, fcmToken, deviceId);
        } else {
            await userDeviceRepository.deactivateAllDevices(userId);
        }
    }
}

export const userDeviceService = new UserDeviceService();
