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

    async findAllActiveDevices(): Promise<UserDevice[]> {
        return await this.deviceRepo.createQueryBuilder("d")
            .where("d.IsActive = 1")
            .andWhere("d.FCMToken IS NOT NULL")
            .andWhere("d.FCMToken != ''")
            .getMany();
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

    async deleteDevices(
        userId?: string | null,
        fcmToken?: string | null,
        deviceId?: string | null,
        logoutAll?: boolean
    ): Promise<number> {
        let totalDeleted = 0;

        // 1. Purge by physical device identifier or FCM push token so this device receives zero notifications
        const tokenClauses: string[] = [];
        const tokenParams: any = {};

        if (deviceId && deviceId.trim() && deviceId !== "unknown_id") {
            tokenClauses.push("PhysicalDeviceId = :deviceId");
            tokenParams.deviceId = deviceId.trim();
        }

        if (fcmToken && fcmToken.trim() && fcmToken !== "no_token_available") {
            tokenClauses.push("FCMToken = :fcmToken");
            tokenParams.fcmToken = fcmToken.trim();
        }

        if (tokenClauses.length > 0) {
            try {
                const res = await this.deviceRepo.createQueryBuilder()
                    .delete()
                    .from(UserDevice)
                    .where(tokenClauses.join(" OR "), tokenParams)
                    .execute();
                totalDeleted += (res.affected || 0);
            } catch (err) {
                console.error("[UserDeviceRepository] Error deleting device by token/id:", err);
            }
        }

        // 2. Unconditionally purge or deactivate devices for this userId so no notifications are routed to logged-out user
        if (userId && userId.trim()) {
            try {
                const res = await this.deviceRepo.createQueryBuilder()
                    .delete()
                    .from(UserDevice)
                    .where("UserId = :userId", { userId: userId.trim() })
                    .execute();
                totalDeleted += (res.affected || 0);
            } catch (err) {
                console.error("[UserDeviceRepository] Error deleting device by userId:", err);
            }
        }

        console.log(`[UserDeviceRepository] Deleted ${totalDeleted} device record(s) from UserDevices for logout. Criteria:`, { userId, deviceId, fcmToken, logoutAll });
        return totalDeleted;
    }
}

export const userDeviceRepository = new UserDeviceRepository();
