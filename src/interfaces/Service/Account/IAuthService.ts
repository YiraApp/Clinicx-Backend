import { User } from "../../../models/Account/user.model.js";

/**
 * Interface for Authentication Service.
 * Defines the contract for user login, token refresh, and logout operations.
 */
export interface IAuthService {
    login(identity: string, password?: string, roleId?: string | string[], deviceInfo?: string, ipAddress?: string): Promise<{
        accessToken: string,
        refreshToken: string,
        accessTokenExpiry: Date,
        refreshTokenExpiry: Date,
        user: Partial<User> & { Roles: any[] }
    }>;
    refreshToken(token: string): Promise<{ accessToken: string, refreshToken: string }>;
    logout(token: string): Promise<void>;
}
