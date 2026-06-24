import bcrypt from "bcrypt";
import { mobileAuthRepository } from "../repositories/mobile-auth.repository.js";
import { userOTPRepository } from "../../../repositories/Account/userotp.repository.js";
import { tokenRepository } from "../../../repositories/Account/token.repository.js";
import { otpService } from "../../../services/Account/otp.service.js";
import { OTPPurpose, OTPType } from "../../../enums/OTPType.enum.js";
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from "../../../utils/jwt.utils.js";
import { User } from "../../../models/Account/user.model.js";

export class MobileAuthService {
    /**
     * Mobile login flow:
     * - Email identity: authenticates with password and returns tokens directly.
     * - Mobile (phone) identity: sends OTP and logs in without password upon verification.
     */
    async login(
        identity: string,
        password?: string,
        countryCode?: string,
        deviceInfo?: string,
        ipAddress?: string,
        isResend?: boolean
    ): Promise<{
        otpSent: boolean;
        sessionId?: string;
        contact?: string;
        contactType?: OTPType;
        message: string;
        accessToken?: string;
        refreshToken?: string;
        accessTokenExpiry?: Date;
        refreshTokenExpiry?: Date;
        user?: Partial<User> & { 
            Roles: any[];
            roleCount?: number;
            hospitalCount?: number;
            organizationCount?: number;
        };
    }> {
        // Detect if identity is email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const isEmail = emailRegex.test(identity);

        if (!isEmail && isResend) {
            const resendResult = await this.resendOTP(identity, countryCode);
            return {
                otpSent: resendResult.otpSent,
                sessionId: resendResult.sessionId,
                contact: resendResult.contact,
                contactType: resendResult.contactType,
                message: resendResult.message
            };
        }

        let lookupIdentity = identity;
        if (!isEmail) {
            if (countryCode && identity.startsWith(countryCode)) {
                lookupIdentity = identity.substring(countryCode.length);
            } else if (identity.startsWith("91")) {
                lookupIdentity = identity.substring(2);
            }
        }

        // Find user (ONLY primary, non-deleted user)
        const user = await mobileAuthRepository.findPrimaryUser(lookupIdentity);

        if (!user) {
            throw new Error("Invalid Mobile Or Email");
        }

        // Check if account is active
        if (!user.Status) {
            throw new Error("User account is inactive");
        }

        if (isEmail) {
            // Email Login: require password and directly authenticate
            if (!password) {
                throw new Error("Password is required for email login");
            }

            if (!user.PasswordHash) {
                throw new Error("Account setup incomplete. Please contact support.");
            }

            const isMatch = await bcrypt.compare(password, user.PasswordHash);
            if (!isMatch) {
                throw new Error("Invalid Password");
            }

            // Generate tokens with 30d expiry
            const payload = { userId: user.Id, email: user.Email };
            const accessToken = generateAccessToken(payload, "30d");
            const refreshToken = generateRefreshToken(payload, "30d");

            const expiryMs = 30 * 24 * 60 * 60 * 1000; // 30 days
            const accessTokenExpiry = new Date(Date.now() + expiryMs);
            const refreshTokenExpiry = new Date(Date.now() + expiryMs);

            // Create session record
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
            await mobileAuthRepository.saveUser(user);

            // Fetch user roles
            const userRoles = await mobileAuthRepository.findUserRoles(user.Id);

            const uniqueRoles = new Set(userRoles.map(ur => ur.RoleId).filter(Boolean));
            const uniqueHospitals = new Set(userRoles.map(ur => ur.HospitalId).filter(Boolean));
            const uniqueOrganizations = new Set(userRoles.map(ur => ur.OrganizationId).filter(Boolean));

            const userResponse: Partial<User> & { 
                Roles: any[];
                roleCount: number;
                hospitalCount: number;
                organizationCount: number;
            } = {
                Id: user.Id,
                IsMobileVerified: user.IsMobileVerified,
                IsEmailVerified: user.IsEmailVerified,
                roleCount: uniqueRoles.size,
                hospitalCount: uniqueHospitals.size,
                organizationCount: uniqueOrganizations.size,
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
                otpSent: false,
                message: "Login successful",
                accessToken,
                refreshToken,
                accessTokenExpiry,
                refreshTokenExpiry,
                user: userResponse
            };
        } else {
            // Mobile Login: no password required, send OTP directly
            const otpTarget = user.PhoneNumber;
            if (!otpTarget) {
                throw new Error("No phone number found for this user");
            }

            // Send OTP using global OTP Service
            const otpResult = await otpService.sendOTP(
                otpTarget,
                OTPPurpose.LOGIN,
                countryCode || user.CountryCode || undefined
            );

            return {
                otpSent: true,
                sessionId: otpResult.sessionId,
                contact: otpTarget,
                contactType: otpResult.contactType,
                message: otpResult.message
            };
        }
    }

    /**
     * Resends the login OTP for mobile phone users.
     */
    async resendOTP(contact: string, countryCode?: string): Promise<{
        otpSent: boolean;
        sessionId: string;
        contact: string;
        contactType: OTPType;
        message: string;
    }> {
        // Find if user is primary and active
        const user = await mobileAuthRepository.findPrimaryUser(contact);
        if (!user) {
            throw new Error("Invalid Mobile Or Email");
        }

        if (!user.Status) {
            throw new Error("User account is inactive");
        }

        // Resend OTP via global OTP Service with LOGIN purpose
        const result = await otpService.resendOTP(
            contact,
            OTPPurpose.LOGIN,
            countryCode || user.CountryCode || undefined
        );

        return {
            otpSent: true,
            sessionId: result.sessionId,
            contact: contact,
            contactType: result.contactType,
            message: result.message
        };
    }

    /**
     * Completes login for mobile phone users after OTP verification.
     */
    async verifyAndLogin(
        contact: string,
        sessionId: string,
        otp: string,
        countryCode?: string,
        deviceInfo?: string,
        ipAddress?: string
    ): Promise<{
        accessToken: string;
        refreshToken: string;
        accessTokenExpiry: Date;
        refreshTokenExpiry: Date;
        user: Partial<User> & { 
            Roles: any[];
            roleCount?: number;
            hospitalCount?: number;
            organizationCount?: number;
        };
    }> {
        // 1. Verify OTP using the repository logic (strip country code if mobile)
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const isEmail = emailRegex.test(contact);
        let lookupContact = contact;
        if (!isEmail) {
            if (countryCode && contact.startsWith(countryCode)) {
                lookupContact = contact.substring(countryCode.length);
            } else if (contact.startsWith("91")) {
                lookupContact = contact.substring(2);
            }
        }

        const verification = await userOTPRepository.verifyOTP(sessionId, lookupContact, otp, OTPPurpose.LOGIN);
        if (!verification.success) {
            throw new Error(verification.message);
        }

        // 2. Load primary user by contact
        const user = await mobileAuthRepository.findPrimaryUser(lookupContact);
        if (!user) {
            throw new Error("User not found or is not primary");
        }

        // Check if account is active
        if (!user.Status) {
            throw new Error("User account is inactive");
        }

        // 3. Generate tokens with 30d expiry
        const payload = { userId: user.Id, email: user.Email };
        const accessToken = generateAccessToken(payload, "30d");
        const refreshToken = generateRefreshToken(payload, "30d");

        const expiryMs = 30 * 24 * 60 * 60 * 1000; // 30 days
        const accessTokenExpiry = new Date(Date.now() + expiryMs);
        const refreshTokenExpiry = new Date(Date.now() + expiryMs);

        // 4. Create session record
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

        // 5. Update LastLoginTime
        user.LastLoginTime = new Date();
        await mobileAuthRepository.saveUser(user);

        // 6. Fetch user roles
        const userRoles = await mobileAuthRepository.findUserRoles(user.Id);

        const uniqueRoles = new Set(userRoles.map(ur => ur.RoleId).filter(Boolean));
        const uniqueHospitals = new Set(userRoles.map(ur => ur.HospitalId).filter(Boolean));
        const uniqueOrganizations = new Set(userRoles.map(ur => ur.OrganizationId).filter(Boolean));

        // 7. Format user response
        const userResponse: Partial<User> & { 
            Roles: any[];
            roleCount: number;
            hospitalCount: number;
            organizationCount: number;
        } = {
            Id: user.Id,
            IsMobileVerified: user.IsMobileVerified,
            IsEmailVerified: user.IsEmailVerified,
            roleCount: uniqueRoles.size,
            hospitalCount: uniqueHospitals.size,
            organizationCount: uniqueOrganizations.size,
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

    /**
     * Refreshes access and refresh tokens for mobile clients with a 30-day lifespan.
     */
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
        const newAccessToken = generateAccessToken(newPayload, "30d");
        const newRefreshToken = generateRefreshToken(newPayload, "30d");

        const expiryMs = 30 * 24 * 60 * 60 * 1000; // 30 days
        const expiryDate = new Date(Date.now() + expiryMs);

        await tokenRepository.updateToken(tokenRecord.TokenId, {
            AccessToken: newAccessToken,
            RefreshToken: newRefreshToken,
            AccessTokenExpiry: expiryDate,
            RefreshTokenExpiry: expiryDate,
            UpdatedAt: new Date()
        });

        return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    }
}

export const mobileAuthService = new MobileAuthService();
