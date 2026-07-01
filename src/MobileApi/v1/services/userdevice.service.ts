import { userDeviceRepository } from "../repositories/userdevice.repository.js";
import { UserDevice } from "../../../models/Account/userdevice.model.js";
import { PlatformType } from "../enums/platform.enum.js";

export class UserDeviceService {
    async registerDeviceToken(
        userId: string,
        platform?: PlatformType,
        currentVersion?: string,
        fcmToken?: string,
        deviceId?: string
    ): Promise<UserDevice> {
        if (!fcmToken && !deviceId) {
            throw new Error("Either deviceId or FCM token is required");
        }

        let device: UserDevice | null = null;

        // 1. Try to find by physical deviceId first
        if (deviceId) {
            device = await userDeviceRepository.findByPhysicalDeviceId(deviceId);
        }

        if (device) {
            // Transfer ownership to current user or update details
            device.UserId = userId;
            if (fcmToken) device.FCMToken = fcmToken;
            if (platform) device.Platform = platform;
            if (currentVersion) device.CurrentVersion = currentVersion;
            device.IsActive = true;
            device.UpdatedAt = new Date();
        } else {
            if (!fcmToken) {
                throw new Error("FCM token is required to register a new device");
            }
            // 2. If no physical device matched or deviceId is null, try to find by Token
            const existingDevice = await userDeviceRepository.findByToken(fcmToken);
            if (existingDevice && existingDevice.UserId === userId) {
                device = existingDevice;
                if (platform) device.Platform = platform;
                if (currentVersion) device.CurrentVersion = currentVersion;
                if (deviceId) device.PhysicalDeviceId = deviceId;
                device.IsActive = true;
                device.UpdatedAt = new Date();
            } else {
                // 3. Otherwise create a brand new device record
                device = new UserDevice();
                device.UserId = userId;
                device.FCMToken = fcmToken;
                device.Platform = platform;
                device.PhysicalDeviceId = deviceId;
                device.CurrentVersion = currentVersion;
                device.IsActive = true;
                device.CreatedAt = new Date();
            }
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
