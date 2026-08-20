import { AppDataSource } from "../../../config/database.js";
import { AppVersion } from "../../../models/Account/app-version.model.js";
import { PlatformType } from "../enums/platform.enum.js";

export class AppVersionRepository {
    private versionRepo = AppDataSource.getRepository(AppVersion);

    async findLatestByPlatform(platform: PlatformType): Promise<AppVersion | null> {
        const platStr = String(platform).toLowerCase();
        let version = await this.versionRepo.findOne({
            where: [
                { Platform: platStr as PlatformType, IsLatest: true, IsDeleted: false },
                { Platform: platform, IsLatest: true, IsDeleted: false }
            ],
            order: { Id: "DESC" }
        });

        if (!version) {
            version = await this.versionRepo.findOne({
                where: [
                    { Platform: platStr as PlatformType, IsDeleted: false },
                    { Platform: platform, IsDeleted: false }
                ],
                order: { Id: "DESC" }
            });
        }
        return version;
    }

    async deactivatePreviousLatest(platform: PlatformType): Promise<void> {
        const platStr = String(platform).toLowerCase();
        await this.versionRepo.update(
            { Platform: platStr as PlatformType, IsLatest: true },
            { IsLatest: false, UpdatedAt: new Date() }
        );
        if (platform !== platStr) {
            await this.versionRepo.update(
                { Platform: platform, IsLatest: true },
                { IsLatest: false, UpdatedAt: new Date() }
            );
        }
    }

    async saveVersion(appVersion: AppVersion): Promise<AppVersion> {
        return await this.versionRepo.save(appVersion);
    }
}

export const appVersionRepository = new AppVersionRepository();
