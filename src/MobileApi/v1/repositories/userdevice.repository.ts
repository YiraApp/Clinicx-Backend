import { AppDataSource } from "../../../config/database.js";
import { UserDevice } from "../../../models/Account/userdevice.model.js";

/**
 * A phone gets pushes only while its account has a live session: a sign-in that
 * hasn't been logged out (revoked) or run out. A phone whose session ended, for
 * example when logout couldn't reach the server, stays quiet.
 */
const LIVE_SESSION = "EXISTS (SELECT 1 FROM UserTokens t WHERE t.UserId = d.UserId AND t.IsRevoked = 0 AND t.RefreshTokenExpiry > :sessionNow)";

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

    /** The user's phones that may get pushes (active, with a live session). */
    async findActiveDevicesByUserId(userId: string): Promise<UserDevice[]> {
        return this.findPushableDevicesByUserIds([userId]);
    }

    /** The phones of these users that may get pushes (active, with a live session). */
    async findPushableDevicesByUserIds(userIds: string[]): Promise<UserDevice[]> {
        const ids = Array.from(new Set(userIds.filter(Boolean)));
        const devices: UserDevice[] = [];
        // SQL Server takes at most 2100 parameters per query.
        for (let i = 0; i < ids.length; i += 1000) {
            devices.push(...await this.deviceRepo.createQueryBuilder("d")
                .where("d.UserId IN (:...ids)", { ids: ids.slice(i, i + 1000) })
                .andWhere("d.IsActive = 1")
                .andWhere(LIVE_SESSION, { sessionNow: new Date() })
                .getMany());
        }
        return devices;
    }

    /** Every phone that may get pushes (active, with a token and a live session). */
    async findAllActiveDevices(): Promise<UserDevice[]> {
        return await this.deviceRepo.createQueryBuilder("d")
            .where("d.IsActive = 1")
            .andWhere("d.FCMToken IS NOT NULL")
            .andWhere("d.FCMToken != ''")
            .andWhere(LIVE_SESSION, { sessionNow: new Date() })
            .getMany();
    }

    async saveDevice(device: UserDevice): Promise<UserDevice> {
        return await this.deviceRepo.save(device);
    }

    /** Stops pushes to a token Firebase no longer accepts, on every row that holds it. */
    async deactivateToken(token: string): Promise<void> {
        await this.deviceRepo.update({ FCMToken: token }, { IsActive: false, UpdatedAt: new Date() });
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
