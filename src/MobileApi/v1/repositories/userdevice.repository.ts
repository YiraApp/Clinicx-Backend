import { AppDataSource } from "../../../config/database.js";
import { UserDevice } from "../../../models/Account/userdevice.model.js";

export class UserDeviceRepository {
    private deviceRepo = AppDataSource.getRepository(UserDevice);

    async findByPhysicalDeviceId(physicalDeviceId: string): Promise<UserDevice | null> {
        return await this.deviceRepo.findOne({
            where: { PhysicalDeviceId: physicalDeviceId }
        });
    }

    async findByToken(token: string): Promise<UserDevice | null> {
        return await this.deviceRepo.findOne({
            where: { FCMToken: token }
        });
    }

    async findActiveDevicesByUserId(userId: string): Promise<UserDevice[]> {
        return await this.deviceRepo.find({
            where: { UserId: userId, IsActive: true }
        });
    }

    async saveDevice(device: UserDevice): Promise<UserDevice> {
        return await this.deviceRepo.save(device);
    }

    async deactivateToken(token: string): Promise<void> {
        const device = await this.findByToken(token);
        if (device) {
            device.IsActive = false;
            device.UpdatedAt = new Date();
            await this.deviceRepo.save(device);
        }
    }

    async deactivateAllDevices(userId: string): Promise<void> {
        await this.deviceRepo.update(
            { UserId: userId },
            { IsActive: false, UpdatedAt: new Date() }
        );
    }

    async deactivateSpecificDevice(userId: string, fcmToken?: string, deviceId?: string): Promise<void> {
        if (!fcmToken && !deviceId) return;

        const updateData = { IsActive: false, UpdatedAt: new Date() };

        if (fcmToken && deviceId) {
            await this.deviceRepo.update(
                [
                    { UserId: userId, FCMToken: fcmToken },
                    { UserId: userId, PhysicalDeviceId: deviceId }
                ],
                updateData
            );
        } else if (fcmToken) {
            await this.deviceRepo.update(
                { UserId: userId, FCMToken: fcmToken },
                updateData
            );
        } else if (deviceId) {
            await this.deviceRepo.update(
                { UserId: userId, PhysicalDeviceId: deviceId },
                updateData
            );
        }
    }
}

export const userDeviceRepository = new UserDeviceRepository();
