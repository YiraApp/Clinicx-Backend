import { AppDataSource } from "../../../config/database.js";
import { AppVersion } from "../../../models/Account/app-version.model.js";
import { PlatformType } from "../enums/platform.enum.js";

export class AppVersionRepository {
    private versionRepo = AppDataSource.getRepository(AppVersion);

    async findLatestByPlatform(platform: PlatformType): Promise<AppVersion | null> {
        return await this.versionRepo.findOne({
            where: { Platform: platform, IsLatest: true, IsDeleted: false }
        });
    }

    async deactivatePreviousLatest(platform: PlatformType): Promise<void> {
        await this.versionRepo.update(
            { Platform: platform, IsLatest: true },
            { IsLatest: false, UpdatedAt: new Date() }
        );
    }

    async saveVersion(appVersion: AppVersion): Promise<AppVersion> {
        return await this.versionRepo.save(appVersion);
    }
}

export const appVersionRepository = new AppVersionRepository();
