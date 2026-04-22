import bcrypt from "bcrypt";
import { AppDataSource } from "../../config/database.js";
import { User } from "../../models/Account/user.model.js";
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from "../../utils/jwt.utils.js";
import { tokenRepository } from "../../repositories/Account/token.repository.js";
import { userRoleRepository } from "../../repositories/Account/userrole.repository.js";
import type { IAuthService } from "../../interfaces/Service/Account/IAuthService.js";

/**
 * Authentication service implementation.
 * Encapsulates the business logic for token lifecycle and user login.
 */
export class AuthService implements IAuthService {
    private userRepository = AppDataSource.getRepository(User);

    async login(identity: string, password?: string, roleId?: string | string[], deviceInfo?: string, ipAddress?: string): Promise<{
        accessToken: string,
        refreshToken: string,
        accessTokenExpiry: Date,
        refreshTokenExpiry: Date,
        user: Partial<User> & { Roles: any[] }
    }> {
        // Find user by Email OR PhoneNumber with Status: true and IsDeleted: false
        const user = await this.userRepository.findOne({
            where: [
                { Email: identity, Status: true, IsDeleted: false },
                { PhoneNumber: identity, Status: true, IsDeleted: false }
            ]
        });

        if (!user) {
            throw new Error("Invalid Mobile Or Email");
        }

        // Check password if provided and stored
        if (password && user.PasswordHash) {
            const isMatch = await bcrypt.compare(password, user.PasswordHash);
            if (!isMatch) {
                throw new Error("Invalid Password");
            }
        } else if (password && !user.PasswordHash) {
            throw new Error("Account setup incomplete. Please contact support.");
        }

        const payload = { userId: user.Id, email: user.Email };
        const accessToken = generateAccessToken(payload);
        const refreshToken = generateRefreshToken(payload);

        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 1);

        const refreshTokenExpiry = expiryDate;

        // Check for existing active session for this device/IP to prevent duplicate rows
        const existingSession = await tokenRepository.findActiveSession(user.Id, deviceInfo, ipAddress);

        const accessTokenExpiryMs = 24 * 60 * 60 * 1000; // Match the 24h in .env
        const accessTokenExpiry = new Date(Date.now() + accessTokenExpiryMs);

        if (existingSession) {
            // Update existing active session instead of creating a new row
            await tokenRepository.updateToken(existingSession.TokenId, {
                AccessToken: accessToken,
                RefreshToken: refreshToken,
                AccessTokenExpiry: accessTokenExpiry,
                RefreshTokenExpiry: refreshTokenExpiry,
                UpdatedAt: new Date()
            });
        } else {
            // Record a new login token
            await tokenRepository.createToken({
                UserId: user.Id,
                AccessToken: accessToken,
                RefreshToken: refreshToken,
                AccessTokenExpiry: accessTokenExpiry,
                RefreshTokenExpiry: refreshTokenExpiry,
                IsRevoked: false,
                ...(deviceInfo && { DeviceInfo: deviceInfo }),
                ...(ipAddress && { IPAddress: ipAddress })
            });
        }

        // Update LastLoginTime
        user.LastLoginTime = new Date();
        await this.userRepository.save(user);

        // Fetch User Roles
        const userRoles = await userRoleRepository.findByUserId(user.Id);

        // Verify if the requested roleId(s) are assigned to the user
        if (roleId) {
            const requestedRoleIds = Array.isArray(roleId) ? roleId : [roleId];
            const hasAnyRole = userRoles.some(ur => requestedRoleIds.includes(ur.RoleId));

            if (!hasAnyRole) {
                throw new Error("Specified role is not assigned to this account.");
            }
        }

        const userResponse: Partial<User> & { Roles: any[] } = {
            Id: user.Id,
            IsMobileVerified: user.IsMobileVerified,
            IsEmailVerified: user.IsEmailVerified,
            Roles: userRoles.map(ur => ({
                UserRoleId: ur.UserRoleId,
                RoleId: ur.RoleId,
                RoleName: ur.Role?.RoleName ?? null,
                OrganizationId: ur.OrganizationId ?? null,
                OrganizationName: ur.Organization?.Name ?? null,
                OrganizationCode: ur.Organization?.OrgCode ?? null,
                HospitalId: ur.HospitalId ?? null,
                HospitalName: ur.Hospital?.Name ?? null,
                HospitalCode: ur.Hospital?.HospitalCode ?? null,
                Status: ur.Status
            }))
        };
        if (user.FirstName !== undefined) userResponse.FirstName = user.FirstName;
        if (user.LastName !== undefined) userResponse.LastName = user.LastName;
        if (user.Email !== undefined) userResponse.Email = user.Email;
        userResponse.PhoneNumber = user.PhoneNumber;
        if (user.CountryCode !== undefined) userResponse.CountryCode = user.CountryCode;

        return {
            accessToken,
            refreshToken,
            accessTokenExpiry,
            refreshTokenExpiry,
            user: userResponse
        };
    }

    async refreshToken(token: string): Promise<{ accessToken: string, refreshToken: string }> {
        if (!token) throw new Error("Refresh token required");

        const payload = verifyRefreshToken(token);
        if (!payload) throw new Error("Invalid refresh token");

        const tokenRecord = await tokenRepository.findByRefreshToken(token);
        if (!tokenRecord || tokenRecord.IsRevoked) {
            throw new Error("Token revoked or not found");
        }

        // Check if the token has expired in the database
        if (tokenRecord.RefreshTokenExpiry < new Date()) {
            await tokenRepository.revokeToken(tokenRecord.TokenId);
            throw new Error("Session expired, please login again");
        }

        const newPayload = { userId: tokenRecord.UserId, email: payload.email };
        const newAccessToken = generateAccessToken(newPayload);
        const newRefreshToken = generateRefreshToken(newPayload);

        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 7);

        await tokenRepository.updateToken(tokenRecord.TokenId, {
            AccessToken: newAccessToken,
            RefreshToken: newRefreshToken,
            AccessTokenExpiry: new Date(Date.now() + 15 * 60 * 1000),
            RefreshTokenExpiry: expiryDate,
            UpdatedAt: new Date()
        });

        return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    }

    async logout(token: string): Promise<void> {
        const tokenRecord = await tokenRepository.findByRefreshToken(token);
        if (tokenRecord) {
            await tokenRepository.revokeToken(tokenRecord.TokenId);
        }
    }
}

// Export singleton
export const authService = new AuthService();
