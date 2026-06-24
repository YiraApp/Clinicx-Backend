import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import { AppDataSource } from "../../config/database.js";
import { User } from "../../models/Account/user.model.js";
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from "../../utils/jwt.utils.js";
import { tokenRepository } from "../../repositories/Account/token.repository.js";
import { userRoleRepository } from "../../repositories/Account/userrole.repository.js";
import { userRepository } from "../../repositories/Account/user.repository.js";
import { passwordResetTokenRepository } from "../../repositories/Account/password-reset-token.repository.js";
import { mailService } from "../../services/Mail/mail.service.js";
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
        // Find user by Email OR PhoneNumber (including inactive)
        const user = await this.userRepository.findOne({
            where: [
                { Email: identity, IsDeleted: false, IsPrimary: true },
                { PhoneNumber: identity, IsDeleted: false, IsPrimary: true }
            ]
        });

        if (!user) {
            throw new Error("Invalid Mobile Or Email");
        }

        // Check if account is inactive
        if (!user.Status) {
            throw new Error("User account is inactive");
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
        const accessTokenExpiryMs = 24 * 60 * 60 * 1000; // Match the 24h in .env
        const accessTokenExpiry = new Date(Date.now() + accessTokenExpiryMs);

        // Always create a new session record so the user can stay logged in from multiple devices/browsers.
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

    async forgotPassword(identity: string): Promise<{ message: string }> {
        const user = await userRepository.findByEmail(identity) || await userRepository.findByPhone(identity);
        if (!user) {
            throw new Error("No account found with this email or phone number");
        }

        const resetToken = uuidv4();
        const expiryTime = new Date();
        expiryTime.setHours(expiryTime.getHours() + 24);

        await passwordResetTokenRepository.invalidatePreviousTokens(user.Id);
        await passwordResetTokenRepository.create({
            UserId: user.Id,
            Token: resetToken,
            ExpiryTime: expiryTime,
            IsUsed: false
        });

        const baseUrl = (process.env.FRONTEND_URL || process.env.CLIENT_URL || "http://localhost:5173").replace(/\/+$/, "");
        const resetUrl = `${baseUrl}/reset-password/${resetToken}`;
        const expiryDateStr = expiryTime.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

        if (user.Email) {
            mailService.sendDynamicEmail("PASSWORD_RESET_EMAIL", user.Email, {
                FirstName: user.FirstName || "User",
                LastName: user.LastName || "",
                Email: user.Email,
                RequestedDateTime: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
                ExpiryTime: expiryDateStr,
                ResetPasswordURL: resetUrl
            }).catch(err => console.error("[AuthService] Failed to send password reset email:", err));
        }

        return {
            message: "If an account exists with this email or phone, a password reset link has been sent."
        };
    }

    async resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
        const resetTokenRecord = await passwordResetTokenRepository.findByToken(token);

        if (!resetTokenRecord) {
            throw new Error("Invalid or expired reset token");
        }

        if (resetTokenRecord.ExpiryTime < new Date()) {
            throw new Error("Reset token has expired");
        }

        if (resetTokenRecord.IsUsed) {
            throw new Error("Reset token has already been used");
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        await userRepository.updateUser(resetTokenRecord.UserId, {
            PasswordHash: hashedPassword
        });

        await passwordResetTokenRepository.markAsUsed(resetTokenRecord.Id);
        await tokenRepository.revokeAllUserTokens(resetTokenRecord.UserId);

        return { message: "Password has been reset successfully" };
    }
}

// Export singleton
export const authService = new AuthService();
