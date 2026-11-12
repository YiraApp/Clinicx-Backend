import { IsNull } from "typeorm/index.js";
import type { SelectQueryBuilder } from "typeorm/index.js";
import jwt from "jsonwebtoken";
import { AppDataSource } from "../../config/database.js";
import { UserToken } from "../../models/Account/usertoken.model.js";
import type { ITokenRepository } from "../../interfaces/Repository/Account/ITokenRepository.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Narrows a token lookup to the user the token was issued to. AccessToken and RefreshToken are
 * NVARCHAR(MAX), which SQL Server cannot index, so matching on them alone read every row of
 * UserTokens on every request. Every token row is saved under the userId its JWT carries (login,
 * signup and refresh all do), so the UserId index finds the few rows to compare instead.
 * The payload is only read here; the caller still verifies the signature.
 */
function withTokenOwner(query: SelectQueryBuilder<UserToken>, token: string): SelectQueryBuilder<UserToken> {
    let userId: unknown;
    try {
        const payload = jwt.decode(token);
        userId = payload && typeof payload === "object" ? payload.userId : undefined;
    } catch {
        userId = undefined;
    }
    if (typeof userId === "string" && GUID.test(userId)) {
        query.andWhere("token.UserId = :tokenUserId", { tokenUserId: userId });
    }
    return query;
}

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
        const query = this.db.createQueryBuilder("token")
            .leftJoinAndSelect("token.user", "user")
            .where("token.AccessToken = :accessToken", { accessToken })
            .andWhere("token.IsRevoked = :isRevoked", { isRevoked: false });
        return await withTokenOwner(query, accessToken).getOne();
    }

    async findByRefreshToken(refreshToken: string): Promise<UserToken | null> {
        const query = this.db.createQueryBuilder("token")
            .leftJoinAndSelect("token.user", "user")
            .where("token.RefreshToken = :refreshToken", { refreshToken });
        return await withTokenOwner(query, refreshToken).getOne();
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
