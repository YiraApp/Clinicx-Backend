import { UserToken } from "../../../models/Account/usertoken.model.js";

/**
 * Interface for UserToken Repository.
 * Handles database operations for authentication tokens.
 */
export interface ITokenRepository {
    createToken(tokenData: Partial<UserToken>): Promise<UserToken>;
    findByAccessToken(accessToken: string): Promise<UserToken | null>;
    findByRefreshToken(refreshToken: string): Promise<UserToken | null>;
    updateToken(tokenId: number, data: Partial<UserToken>): Promise<any>;
    revokeToken(tokenId: number): Promise<any>;
    revokeAllUserTokens(userId: string): Promise<any>;
    revokePreviousSession(userId: string, deviceInfo?: string, ipAddress?: string): Promise<any>;
    findActiveSession(userId: string, deviceInfo?: string, ipAddress?: string): Promise<UserToken | null>;
    cleanupTokens(): Promise<any>;
}
