import { appVersionRepository } from "../repositories/app-version.repository.js";
import { AppVersion } from "../../../models/Account/app-version.model.js";
import { PlatformType } from "../enums/platform.enum.js";

export class AppVersionService {
    private cleanVersion(v: string): number[] {
        if (!v) return [0, 0, 0];
        // Strip leading 'v' / 'V' and any metadata after '+' or '-'
        const raw = v.replace(/^v/i, '').split('+')[0].split('-')[0].trim();
        const parts = raw.split('.').map(part => {
            const num = parseInt(part.replace(/\D/g, ''), 10);
            return isNaN(num) ? 0 : num;
        });
        while (parts.length < 3) {
            parts.push(0);
        }
        return parts;
    }

    private isLessThan(v1: string, v2: string): boolean {
        const parts1 = this.cleanVersion(v1);
        const parts2 = this.cleanVersion(v2);
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
            const num1 = parts1[i] ?? 0;
            const num2 = parts2[i] ?? 0;
            if (num1 < num2) return true;
            if (num1 > num2) return false;
        }
        return false;
    }

    async getLatestAppVersion(platform: PlatformType): Promise<AppVersion | null> {
        if (!platform) {
            throw new Error("Platform is required");
        }
        return await appVersionRepository.findLatestByPlatform(platform);
    }

    async checkVersion(platform: PlatformType, currentVersion: string) {
        const latest = await this.getLatestAppVersion(platform);
        if (!latest) {
            return null;
        }

        const updateAvailable = this.isLessThan(currentVersion, latest.Version);
        let forceUpdate = false;
        if (updateAvailable) {
            forceUpdate = !!latest.ForceUpdate;
            if (latest.MinVersion && this.isLessThan(currentVersion, latest.MinVersion)) {
                forceUpdate = true;
            }
        }

        return {
            platform: latest.Platform,
            latestVersion: latest.Version,
            minVersion: latest.MinVersion,
            forceUpdate,
            updateAvailable,
            url: latest.Url
        };
    }

    async createNewVersion(
        platform: PlatformType,
        version: string,
        minVersion: string,
        forceUpdate: boolean,
        url?: string,
        maintenance?: boolean,
        logout?: boolean
    ): Promise<AppVersion> {
        if (!platform || !version || !minVersion) {
            throw new Error("Platform, version, and minVersion are required");
        }

        // 1. Deactivate previous latest records
        await appVersionRepository.deactivatePreviousLatest(platform);

        // 2. Save new version
        const newAppVersion = new AppVersion();
        newAppVersion.Platform = platform;
        newAppVersion.Version = version;
        newAppVersion.MinVersion = minVersion;
        newAppVersion.ForceUpdate = forceUpdate;
        newAppVersion.Url = url;
        newAppVersion.Maintenance = maintenance === true;
        newAppVersion.Logout = logout === true;
        newAppVersion.IsLatest = true;
        newAppVersion.IsDeleted = false;
        newAppVersion.CreatedAt = new Date();

        return await appVersionRepository.saveVersion(newAppVersion);
    }
}

export const appVersionService = new AppVersionService();
