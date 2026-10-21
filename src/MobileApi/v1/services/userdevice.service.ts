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

        let device: UserDevice | null = null;
        if (deviceId && deviceId.trim() && deviceId !== "unknown_id") {
            device = await userDeviceRepository.findByPhysicalDeviceId(deviceId.trim());
        }
        if (!device && fcmToken && fcmToken.trim() && fcmToken !== "no_token_available") {
            device = await userDeviceRepository.findByToken(fcmToken.trim());
        }

        if (device) {
            // Transfer ownership to current user or update details
            device.UserId = userId;
            device.FCMToken = fcmToken;
            if (platform) device.Platform = platform;
            if (currentVersion) device.CurrentVersion = currentVersion;
            if (deviceId && deviceId !== "unknown_id") device.PhysicalDeviceId = deviceId;
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

        const saved = await userDeviceRepository.saveDevice(device);
        // Clean up any other stale records for this physical device or FCM token belonging to any other user
        try {
            const cleanResult = await AppDataSource.createQueryBuilder()
                .delete()
                .from(UserDevice)
                .where("((PhysicalDeviceId = :deviceId AND PhysicalDeviceId != 'unknown_id') OR FCMToken = :fcmToken) AND Id != :savedId", {
                    deviceId: deviceId ? deviceId.trim() : "",
                    fcmToken: fcmToken ? fcmToken.trim() : "",
                    savedId: saved.Id
                })
                .execute();
            console.log(`[UserDeviceService] Purged ${cleanResult.affected || 0} older device record(s) for token/deviceId`);
        } catch (cleanupErr: any) {
            console.error("[UserDeviceService] Error cleaning up stale device records:", cleanupErr && cleanupErr.message ? cleanupErr.message : cleanupErr);
        }
        return saved;
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

    async deleteDevices(
        userId?: string | null,
        fcmToken?: string | null,
        deviceId?: string | null,
        logoutAll?: boolean
    ): Promise<number> {
        return await userDeviceRepository.deleteDevices(userId, fcmToken, deviceId, logoutAll);
    }
}

export const userDeviceService = new UserDeviceService();
