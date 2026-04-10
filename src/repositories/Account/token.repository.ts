import { IsNull } from "typeorm";
import { AppDataSource } from "../../config/database.js";
import { UserToken } from "../../models/Account/usertoken.model.js";
import type { ITokenRepository } from "../../interfaces/Repository/Account/ITokenRepository.js";

/**
 * TokenRepository implementation.
 * Handles persistence and lifecycle of user authentication tokens.
 */
export class TokenRepository implements ITokenRepository {
    private db = AppDataSource.getRepository(UserToken);

    async createToken(tokenData: Partial<UserToken>): Promise<UserToken> {
        const newToken = this.db.create(tokenData);
        return await this.db.save(newToken);
    }

    async findByAccessToken(accessToken: string): Promise<UserToken | null> {
        return await this.db.findOne({
            where: { AccessToken: accessToken, IsRevoked: false },
            relations: ["user"]
        });
    }

    async findByRefreshToken(refreshToken: string): Promise<UserToken | null> {
        return await this.db.findOne({
            where: { RefreshToken: refreshToken },
            relations: ["user"]
        });
    }

    async updateToken(tokenId: number, data: Partial<UserToken>): Promise<any> {
        return await this.db.update(tokenId, data);
    }

    async revokeToken(tokenId: number): Promise<any> {
        return await this.db.update(tokenId, { IsRevoked: true, UpdatedAt: new Date() });
    }

    async revokeAllUserTokens(userId: string): Promise<any> {
        return await this.db.update({ UserId: userId }, { IsRevoked: true, UpdatedAt: new Date() });
    }

    async revokePreviousSession(userId: string, deviceInfo?: string, ipAddress?: string): Promise<any> {
        const where: any = { UserId: userId, IsRevoked: false };
        if (deviceInfo) where.DeviceInfo = deviceInfo;
        else where.DeviceInfo = IsNull();
        if (ipAddress) where.IPAddress = ipAddress;
        else where.IPAddress = IsNull();

        return await this.db.update(where, { IsRevoked: true, UpdatedAt: new Date() });
    }

    async findActiveSession(userId: string, deviceInfo?: string, ipAddress?: string): Promise<UserToken | null> {
        return await this.db.findOne({
            where: {
                UserId: userId,
                DeviceInfo: deviceInfo ?? IsNull(),
                IPAddress: ipAddress ?? IsNull(),
                IsRevoked: false
            }
        });
    }

    async cleanupTokens(): Promise<any> {
        const now = new Date();
        return await this.db.createQueryBuilder()
            .delete()
            .where("RefreshTokenExpiry < :now OR IsRevoked = :isRevoked", { now, isRevoked: true })
            .execute();
    }
}

// Export singleton instance
export const tokenRepository = new TokenRepository();

// Maintain functional exports for existing code (compatibility)
export const createToken = (data: any) => tokenRepository.createToken(data);
export const findByAccessToken = (token: string) => tokenRepository.findByAccessToken(token);
export const findByRefreshToken = (token: string) => tokenRepository.findByRefreshToken(token);
export const updateToken = (id: number, data: any) => tokenRepository.updateToken(id, data);
export const revokeToken = (id: number) => tokenRepository.revokeToken(id);
export const revokeAllUserTokens = (uid: string) => tokenRepository.revokeAllUserTokens(uid);
