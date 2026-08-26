import bcrypt from "bcrypt";
import { mobileAuthRepository } from "../repositories/mobile-auth.repository.js";
import { userOTPRepository } from "../../../repositories/Account/userotp.repository.js";
import { tokenRepository } from "../../../repositories/Account/token.repository.js";
import { otpService } from "../../../services/Account/otp.service.js";
import { mailService } from "../../../services/Mail/mail.service.js";
import { OTPPurpose, OTPType } from "../../../enums/OTPType.enum.js";
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from "../../../utils/jwt.utils.js";
import { User } from "../../../models/Account/user.model.js";
import { AppDataSource } from "../../../config/database.js";
import { UserOTP } from "../../../models/Account/userotp.model.js";

export class MobileAuthService {
    /**
     * Sends (or resends) an OTP to the mobile user if they are registered and active with allowed roles.
     */
    async sendOTP(
        identity: string,
        countryCode?: string,
        isResend?: boolean
    ): Promise<{
        otpSent: boolean;
        sessionId: string;
        contact: string;
        contactType: OTPType;
        message: string;
    }> {
        // Detect if identity is email (throw error if it is)
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (emailRegex.test(identity)) {
            throw new Error("Email cannot be used for OTP login");
        }

        const digitsOnly = identity.replace(/\D/g, "");
        let lookupIdentity = digitsOnly.length > 10 ? digitsOnly.slice(-10) : digitsOnly;

        // Find user (ONLY primary, non-deleted user)
        const user = await mobileAuthRepository.findPrimaryUser(lookupIdentity);

        if (!user) {
            throw new Error("User not registered");
        }

        // Check if account is active
        if (!user.Status) {
            throw new Error("User account is inactive");
        }

        // Fetch user roles
        const userRoles = await mobileAuthRepository.findUserRoles(user.Id);
        const allowedRoleIds = [
            "4FC67429-28AE-4106-93EF-436228282ED0", // Patient
            "FE80173F-9DB3-4703-84A8-5C23E7CC493C"  // Provider
        ];
        const mobileRoles = userRoles.filter(ur => ur.RoleId && allowedRoleIds.includes(ur.RoleId.toUpperCase()));
        if (mobileRoles.length === 0) {
            throw new Error("Access denied. Only patients and providers can log in.");
        }

        const otpTarget = user.PhoneNumber;
        if (!otpTarget) {
            throw new Error("No phone number found for this user");
        }

        if (isResend) {
            // Resend OTP via global OTP Service with LOGIN purpose
            const result = await otpService.resendOTP(
                otpTarget,
                OTPPurpose.LOGIN,
                countryCode || user.CountryCode || undefined,
                undefined,
                true
            );

            return {
                otpSent: true,
                sessionId: result.sessionId,
                contact: otpTarget,
                contactType: result.contactType,
                message: result.message
            };
        } else {
            // Send OTP using global OTP Service
            const otpResult = await otpService.sendOTP(
                otpTarget,
                OTPPurpose.LOGIN,
                countryCode || user.CountryCode || undefined,
                undefined,
                undefined,
                undefined,
                true
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
     * Unified mobile login flow:
     * - Email loginType: authenticates with password and returns tokens.
     * - Mobile loginType: verifies OTP using sessionId and password (as OTP code) and returns tokens.
     */
    async login(
        identity: string,
        password?: string, // Password for email, OTP code for mobile
        loginType?: "email" | "mobile" | "mobileNumber",
        sessionId?: string, // Required for mobile login
        countryCode?: string,
        deviceInfo?: string,
        ipAddress?: string
    ): Promise<{
        accessToken: string;
        refreshToken: string;
        accessTokenExpiry: Date;
        refreshTokenExpiry: Date;
        id: string;
        isMobileVerified: boolean;
        isEmailVerified: boolean;
        roleCount: number;
        hospitalCount: number;
        organizationCount: number;
        roles: any[];
        firstName: string | null;
        lastName: string | null;
        email: string | null;
        phoneNumber: string;
        countryCode: string | null;
        gender: string | null;
        dob: string | null;
        height: string | null;
        weight: string | null;
        heightUnit: string;
        weightUnit: string;
        latestRoleId: string | null;
        latestOrgId: number | null;
        latestHospitalId: number | null;
        latestUserRole: string | null;
        navigationId: string | null;
    }> {
        const type = loginType === "mobileNumber" ? "mobile" : (loginType || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity) ? "email" : "mobile"));

        if (type === "email") {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            const isEmail = emailRegex.test(identity);
            if (!isEmail) {
                throw new Error("Invalid email format");
            }

            const user = await mobileAuthRepository.findPrimaryUser(identity);
            if (!user) {
                throw new Error("Invalid emailid");
            }

            if (!user.Status) {
                throw new Error("Invalid emailid");
            }

            if (!password) {
                throw new Error("Password is required for email login");
            }

            if (!user.PasswordHash) {
                throw new Error("Account setup incomplete. Please contact support.");
            }

            const isMatch = await bcrypt.compare(password, user.PasswordHash);
            if (!isMatch) {
                throw new Error("Invalid password");
            }

            // Fetch user roles
            const userRoles = await mobileAuthRepository.findUserRoles(user.Id);
            /*
            const allowedRoleIds = [
                "4FC67429-28AE-4106-93EF-436228282ED0", // Patient
                "FE80173F-9DB3-4703-84A8-5C23E7CC493C"  // Provider
            ];
            const mobileRoles = userRoles.filter(ur => ur.RoleId && allowedRoleIds.includes(ur.RoleId.toUpperCase()));
            if (mobileRoles.length === 0) {
                throw new Error("Access denied. Only patients and providers can log in.");
            }
            */
            const mobileRoles = userRoles;
            if (mobileRoles.length === 0) {
                throw new Error("Access denied. User has no assigned roles.");
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

            if (!user.LatestRoleId && mobileRoles.length > 0) {
                const defaultRole = mobileRoles[0];
                user.LatestRoleId = defaultRole.RoleId;
                user.LatestOrgId = defaultRole.OrganizationId ?? null;
                user.LatestHospitalId = defaultRole.HospitalId ?? null;
            }

            // Update LastLoginTime
            user.LastLoginTime = new Date();
            await mobileAuthRepository.saveUser(user);

            const uniqueRoles = new Set(mobileRoles.map(ur => ur.RoleId).filter(Boolean));
            const uniqueHospitals = new Set(mobileRoles.map(ur => ur.HospitalId).filter(Boolean));
            const uniqueOrganizations = new Set(mobileRoles.map(ur => ur.OrganizationId).filter(Boolean));

            const uniqueRolesMap = new Map<string, any>();
            for (const ur of mobileRoles) {
                if (ur.RoleId) {
                    const roleIdUpper = ur.RoleId.toUpperCase();
                    if (!uniqueRolesMap.has(roleIdUpper)) {
                        let roleName = ur.Role?.RoleName ?? null;
                        if (roleIdUpper === "4FC67429-28AE-4106-93EF-436228282ED0" && roleName === "Patient") {
                            roleName = "User/ Patient";
                        }
                        uniqueRolesMap.set(roleIdUpper, {
                            roleId: ur.RoleId,
                            roleName: roleName,
                            status: ur.Status
                        });
                    }
                }
            }
            const rolesList = Array.from(uniqueRolesMap.values());

            let latestUserRole: string | null = null;
            if (user.LatestRoleId) {
                const matched = mobileRoles.find(ur => ur.RoleId?.toUpperCase() === user.LatestRoleId?.toUpperCase());
                if (matched) {
                    latestUserRole = matched.Role?.RoleName ?? null;
                }
            }

            return {
                accessToken,
                refreshToken,
                accessTokenExpiry,
                refreshTokenExpiry,
                id: user.Id,
                isMobileVerified: user.IsMobileVerified,
                isEmailVerified: user.IsEmailVerified,
                roleCount: uniqueRoles.size,
                hospitalCount: uniqueHospitals.size,
                organizationCount: uniqueOrganizations.size,
                roles: rolesList,
                firstName: user.FirstName ?? null,
                lastName: user.LastName ?? null,
                email: user.Email ?? null,
                phoneNumber: user.PhoneNumber,
                countryCode: user.CountryCode ?? null,
                gender: user.Gender ?? null,
                dob: formatDOB(user.DateOfBirth),
                height: user.Height != null ? String(user.Height) : null,
                weight: user.Weight != null ? String(user.Weight) : null,
                heightUnit: "cms",
                weightUnit: "kgs",
                latestRoleId: user.LatestRoleId ?? null,
                latestOrgId: user.LatestOrgId ?? null,
                latestHospitalId: user.LatestHospitalId ?? null,
                latestUserRole,
                navigationId: getNavigationId(user.LatestRoleId)
            };
        } else {
            // Mobile OTP Login: calls verification in login method
            if (!sessionId) {
                throw new Error("Session ID is required for mobile OTP login");
            }
            if (!password) {
                throw new Error("OTP is required for mobile OTP login");
            }

            let lookupContact = identity;
            if (countryCode && identity.startsWith(countryCode)) {
                lookupContact = identity.substring(countryCode.length);
            } else if (identity.startsWith("91")) {
                lookupContact = identity.substring(2);
            }

            const verification = await userOTPRepository.verifyOTP(sessionId, lookupContact, password, OTPPurpose.LOGIN);
            if (!verification.success) {
                throw new Error("Invalid OTP. Please check the code and try again.");
            }

            const user = await mobileAuthRepository.findPrimaryUser(lookupContact);
            if (!user) {
                throw new Error("Authentication failed. Please try again.");
            }

            // Check if account is active
            if (!user.Status) {
                throw new Error("Authentication failed. Please try again.");
            }

            // Fetch user roles
            const userRoles = await mobileAuthRepository.findUserRoles(user.Id);
            const allowedRoleIds = [
                "4FC67429-28AE-4106-93EF-436228282ED0", // Patient
                "FE80173F-9DB3-4703-84A8-5C23E7CC493C"  // Provider
            ];
            const mobileRoles = userRoles.filter(ur => ur.RoleId && allowedRoleIds.includes(ur.RoleId.toUpperCase()));
            if (mobileRoles.length === 0) {
                throw new Error("Access denied. Only patients and providers can log in.");
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

            if (!user.LatestRoleId && mobileRoles.length > 0) {
                const defaultRole = mobileRoles[0];
                user.LatestRoleId = defaultRole.RoleId;
                user.LatestOrgId = defaultRole.OrganizationId ?? null;
                user.LatestHospitalId = defaultRole.HospitalId ?? null;
            }

            // Update LastLoginTime
            user.LastLoginTime = new Date();
            await mobileAuthRepository.saveUser(user);

            const uniqueRoles = new Set(mobileRoles.map(ur => ur.RoleId).filter(Boolean));
            const uniqueHospitals = new Set(mobileRoles.map(ur => ur.HospitalId).filter(Boolean));
            const uniqueOrganizations = new Set(mobileRoles.map(ur => ur.OrganizationId).filter(Boolean));

            const uniqueRolesMap = new Map<string, any>();
            for (const ur of mobileRoles) {
                if (ur.RoleId) {
                    const roleIdUpper = ur.RoleId.toUpperCase();
                    if (!uniqueRolesMap.has(roleIdUpper)) {
                        let roleName = ur.Role?.RoleName ?? null;
                        if (roleIdUpper === "4FC67429-28AE-4106-93EF-436228282ED0" && roleName === "Patient") {
                            roleName = "User/ Patient";
                        }
                        uniqueRolesMap.set(roleIdUpper, {
                            roleId: ur.RoleId,
                            roleName: roleName,
                            status: ur.Status
                        });
                    }
                }
            }
            const rolesList = Array.from(uniqueRolesMap.values());

            let latestUserRole: string | null = null;
            if (user.LatestRoleId) {
                const matched = mobileRoles.find(ur => ur.RoleId?.toUpperCase() === user.LatestRoleId?.toUpperCase());
                if (matched) {
                    latestUserRole = matched.Role?.RoleName ?? null;
                }
            }

            return {
                accessToken,
                refreshToken,
                accessTokenExpiry,
                refreshTokenExpiry,
                id: user.Id,
                isMobileVerified: user.IsMobileVerified,
                isEmailVerified: user.IsEmailVerified,
                roleCount: uniqueRoles.size,
                hospitalCount: uniqueHospitals.size,
                organizationCount: uniqueOrganizations.size,
                roles: rolesList,
                firstName: user.FirstName ?? null,
                lastName: user.LastName ?? null,
                email: user.Email ?? null,
                phoneNumber: user.PhoneNumber,
                countryCode: user.CountryCode ?? null,
                gender: user.Gender ?? null,
                dob: formatDOB(user.DateOfBirth),
                height: user.Height != null ? String(user.Height) : null,
                weight: user.Weight != null ? String(user.Weight) : null,
                heightUnit: "cms",
                weightUnit: "kgs",
                latestRoleId: user.LatestRoleId ?? null,
                latestOrgId: user.LatestOrgId ?? null,
                latestHospitalId: user.LatestHospitalId ?? null,
                latestUserRole,
                navigationId: getNavigationId(user.LatestRoleId)
            };
        }
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

    /**
     * Gets all organizations and their associated hospitals mapped to a user and role.
     */
    async getUserOrganizationHospitals(
        userId: string,
        roleId: string
    ): Promise<any[]> {
        const userRoles = await mobileAuthRepository.findUserRolesByRole(userId, roleId);

        const orgMap = new Map<number, {
            organizationId: number;
            organizationName: string;
            organizationCode: string | null;
            hospitals: any[];
        }>();

        for (const ur of userRoles) {
            if (ur.OrganizationId && ur.Organization) {
                if (!orgMap.has(ur.OrganizationId)) {
                    orgMap.set(ur.OrganizationId, {
                        organizationId: ur.OrganizationId,
                        organizationName: ur.Organization.Name,
                        organizationCode: ur.Organization.OrgCode ?? null,
                        hospitals: []
                    });
                }

                const orgData = orgMap.get(ur.OrganizationId)!;

                if (ur.HospitalId && ur.Hospital) {
                    const exists = orgData.hospitals.some(h => h.hospitalId === ur.HospitalId);
                    if (!exists) {
                        orgData.hospitals.push({
                            hospitalId: ur.Hospital.Id,
                            hospitalCode: ur.Hospital.HospitalCode ?? null,
                            hospitalName: ur.Hospital.Name,
                            email: ur.Hospital.Email ?? null,
                            mobileNumber: ur.Hospital.MobileNumber ?? null,
                            countryCode: ur.Hospital.CountryCode ?? null,
                            address: ur.Hospital.Address ?? null,
                            helplineNumber: ur.Hospital.HelplineNumber ?? null,
                            website: ur.Hospital.Website ?? null,
                            city: ur.Hospital.City ?? null,
                            state: ur.Hospital.State ?? null,
                            country: ur.Hospital.Country ?? null,
                            pincode: ur.Hospital.Pincode ?? null,
                            status: ur.Hospital.Status ?? null,
                            is24Hours: ur.Hospital.Is24Hours ?? null
                        });
                    }
                } else if (!ur.HospitalId) {
                    // Fallback to fetch all active hospitals under this organization
                    const allOrgHospitals = await mobileAuthRepository.findHospitalsByOrganization(ur.OrganizationId);
                    for (const hosp of allOrgHospitals) {
                        const exists = orgData.hospitals.some(h => h.hospitalId === hosp.Id);
                        if (!exists) {
                            orgData.hospitals.push({
                                hospitalId: hosp.Id,
                                hospitalCode: hosp.HospitalCode ?? null,
                                hospitalName: hosp.Name,
                                email: hosp.Email ?? null,
                                mobileNumber: hosp.MobileNumber ?? null,
                                countryCode: hosp.CountryCode ?? null,
                                address: hosp.Address ?? null,
                                helplineNumber: hosp.HelplineNumber ?? null,
                                website: hosp.Website ?? null,
                                city: hosp.City ?? null,
                                state: hosp.State ?? null,
                                country: hosp.Country ?? null,
                                pincode: hosp.Pincode ?? null,
                                status: hosp.Status ?? null,
                                is24Hours: hosp.Is24Hours ?? null
                            });
                        }
                    }
                }
            }
        }

        return Array.from(orgMap.values());
    }

    /**
     * Updates the user's latest session context (LatestRoleId, LatestOrgId, LatestHospitalId).
     */
    async updateLatestContext(
        userId: string,
        latestRoleId?: string,
        latestOrgId?: number,
        latestHospitalId?: number
    ): Promise<User> {
        const user = await mobileAuthRepository.findUserById(userId);
        if (!user) {
            throw new Error("User not found");
        }

        if (latestRoleId !== undefined) user.LatestRoleId = latestRoleId || null;
        if (latestOrgId !== undefined) user.LatestOrgId = latestOrgId || null;
        if (latestHospitalId !== undefined) user.LatestHospitalId = latestHospitalId || null;

        return await mobileAuthRepository.saveUser(user);
    }

    /**
     * Retrieves all profile and session context details for an authenticated user.
     */
    async getUserData(userId: string, deviceId?: string): Promise<{
        accessToken?: string;
        refreshToken?: string;
        accessTokenExpiry?: Date;
        refreshTokenExpiry?: Date;
        id: string;
        isMobileVerified: boolean;
        isEmailVerified: boolean;
        roleCount: number;
        hospitalCount: number;
        organizationCount: number;
        roles: any[];
        firstName: string | null;
        lastName: string | null;
        email: string | null;
        phoneNumber: string;
        countryCode: string | null;
        gender: string | null;
        dob: string | null;
        height: string | null;
        weight: string | null;
        heightUnit: string;
        weightUnit: string;
        latestRoleId: string | null;
        latestOrgId: number | null;
        latestHospitalId: number | null;
        latestUserRole: string | null;
        navigationId: string | null;
    }> {
        const user = await mobileAuthRepository.findUserById(userId);
        if (!user) {
            throw new Error("User not found");
        }

        // Fetch user roles
        const userRoles = await mobileAuthRepository.findUserRoles(user.Id);
        /*
        const allowedRoleIds = [
            "4FC67429-28AE-4106-93EF-436228282ED0", // Patient
            "FE80173F-9DB3-4703-84A8-5C23E7CC493C"  // Provider
        ];
        const mobileRoles = userRoles.filter(ur => ur.RoleId && allowedRoleIds.includes(ur.RoleId.toUpperCase()));
        */
        const mobileRoles = userRoles;

        if (!user.LatestRoleId && mobileRoles.length > 0) {
            const defaultRole = mobileRoles[0];
            user.LatestRoleId = defaultRole.RoleId;
            user.LatestOrgId = defaultRole.OrganizationId ?? null;
            user.LatestHospitalId = defaultRole.HospitalId ?? null;
            await mobileAuthRepository.saveUser(user);
        }

        const uniqueRoles = new Set(mobileRoles.map(ur => ur.RoleId).filter(Boolean));
        const uniqueHospitals = new Set(mobileRoles.map(ur => ur.HospitalId).filter(Boolean));
        const uniqueOrganizations = new Set(mobileRoles.map(ur => ur.OrganizationId).filter(Boolean));

        const uniqueRolesMap = new Map<string, any>();
        for (const ur of mobileRoles) {
            if (ur.RoleId) {
                const roleIdUpper = ur.RoleId.toUpperCase();
                if (!uniqueRolesMap.has(roleIdUpper)) {
                    let roleName = ur.Role?.RoleName ?? null;
                    if (roleIdUpper === "4FC67429-28AE-4106-93EF-436228282ED0" && roleName === "Patient") {
                        roleName = "User/ Patient";
                    }
                    uniqueRolesMap.set(roleIdUpper, {
                        roleId: ur.RoleId,
                        roleName: roleName,
                        status: ur.Status
                    });
                }
            }
        }
        const rolesList = Array.from(uniqueRolesMap.values());

        let accessToken: string | undefined;
        let refreshToken: string | undefined;
        let accessTokenExpiry: Date | undefined;
        let refreshTokenExpiry: Date | undefined;

        if (deviceId) {
            const payload = { userId: user.Id, email: user.Email };
            accessToken = generateAccessToken(payload, "30d");
            refreshToken = generateRefreshToken(payload, "30d");

            const expiryMs = 30 * 24 * 60 * 60 * 1000; // 30 days
            accessTokenExpiry = new Date(Date.now() + expiryMs);
            refreshTokenExpiry = new Date(Date.now() + expiryMs);

            await tokenRepository.createToken({
                UserId: user.Id,
                AccessToken: accessToken,
                RefreshToken: refreshToken,
                AccessTokenExpiry: accessTokenExpiry,
                RefreshTokenExpiry: refreshTokenExpiry,
                IsRevoked: false,
                DeviceInfo: deviceId
            });
        }

        let latestUserRole: string | null = null;
        if (user.LatestRoleId) {
            const matched = mobileRoles.find(ur => ur.RoleId?.toUpperCase() === user.LatestRoleId?.toUpperCase());
            if (matched) {
                latestUserRole = matched.Role?.RoleName ?? null;
            }
        }

        return {
            ...(accessToken && { accessToken }),
            ...(refreshToken && { refreshToken }),
            ...(accessTokenExpiry && { accessTokenExpiry }),
            ...(refreshTokenExpiry && { refreshTokenExpiry }),
            id: user.Id,
            isMobileVerified: user.IsMobileVerified,
            isEmailVerified: user.IsEmailVerified,
            roleCount: uniqueRoles.size,
            hospitalCount: uniqueHospitals.size,
            organizationCount: uniqueOrganizations.size,
            roles: rolesList,
            firstName: user.FirstName ?? null,
            lastName: user.LastName ?? null,
            email: user.Email ?? null,
            phoneNumber: user.PhoneNumber,
            countryCode: user.CountryCode ?? null,
            gender: user.Gender ?? null,
            dob: formatDOB(user.DateOfBirth),
            height: user.Height != null ? String(user.Height) : null,
            weight: user.Weight != null ? String(user.Weight) : null,
            heightUnit: "cms",
            weightUnit: "kgs",
            latestRoleId: user.LatestRoleId ?? null,
            latestOrgId: user.LatestOrgId ?? null,
            latestHospitalId: user.LatestHospitalId ?? null,
            latestUserRole,
            navigationId: getNavigationId(user.LatestRoleId)
        };
    }

    async sendForgotPasswordOTP(identity: string, contactType?: string, isResend?: boolean, countryCode?: string): Promise<{
        sessionId: string;
        contact: string;
        contactType: OTPType;
        countryCode: string | null;
        message: string;
    }> {
        const isEmail = contactType 
            ? String(contactType).toUpperCase() === "EMAIL"
            : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity);

        let lookupIdentity = identity;
        if (!isEmail) {
            if (countryCode && identity.startsWith(countryCode)) {
                lookupIdentity = identity.substring(countryCode.length);
            } else if (identity.startsWith("91")) {
                lookupIdentity = identity.substring(2);
            }
        }

        const user = await mobileAuthRepository.findPrimaryUser(lookupIdentity);
        if (!user) {
            throw new Error("User not registered");
        }

        if (!user.Status) {
            throw new Error("User account is inactive");
        }

        const otpTarget = isEmail ? user.Email : user.PhoneNumber;
        if (!otpTarget) {
            throw new Error(isEmail ? "No email found for this user" : "No phone number found for this user");
        }

        // For email, templateCode is EMAIL_OTP_VERIFICATION.
        const templateCode = isEmail ? "EMAIL_OTP_VERIFICATION" : undefined;

        let otpResult;
        if (isResend) {
            otpResult = await otpService.resendOTP(
                otpTarget,
                OTPPurpose.PASSWORD_RESET,
                isEmail ? undefined : (countryCode || user.CountryCode || undefined),
                undefined,
                !isEmail
            );
        } else {
            otpResult = await otpService.sendOTP(
                otpTarget,
                OTPPurpose.PASSWORD_RESET,
                isEmail ? undefined : (countryCode || user.CountryCode || undefined),
                templateCode,
                undefined,
                undefined,
                !isEmail
            );
        }

        return {
            sessionId: otpResult.sessionId,
            contact: otpTarget,
            contactType: otpResult.contactType,
            countryCode: isEmail ? null : (countryCode || user.CountryCode || null),
            message: otpResult.message
        };
    }

    async resetPasswordWithOTP(
        identity: string,
        sessionId: string,
        otp: string,
        newPassword: string,
        contactType?: string,
        countryCode?: string
    ): Promise<{ message: string }> {
        const isEmail = contactType 
            ? String(contactType).toUpperCase() === "EMAIL"
            : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity);

        let lookupIdentity = identity;
        if (!isEmail) {
            if (countryCode && identity.startsWith(countryCode)) {
                lookupIdentity = identity.substring(countryCode.length);
            } else if (identity.startsWith("91")) {
                lookupIdentity = identity.substring(2);
            }
        }

        // 1. Verify OTP first
        const verification = await otpService.verifyOTP(
            identity,
            sessionId,
            otp,
            OTPPurpose.PASSWORD_RESET,
            isEmail ? undefined : countryCode
        );

        if (!verification.success) {
            throw new Error(verification.message);
        }

        // 2. Fetch primary user
        const user = await mobileAuthRepository.findPrimaryUser(lookupIdentity);
        if (!user) {
            throw new Error("User not found");
        }

        // 3. Update password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        user.PasswordHash = hashedPassword;
        user.UpdatedAt = new Date();
        await mobileAuthRepository.saveUser(user);

        // 4. Revoke active tokens/sessions for safety
        await tokenRepository.revokeAllUserTokens(user.Id);

        // 5. Send email notification if user has a registered email address
        if (user.Email) {
            mailService.sendMail({
                to: user.Email,
                subject: "Yira - Password Changed Successfully",
                body: `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Password Changed</title>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:Segoe UI, Arial,sans-serif;">

<table style="max-width:520px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.08);width:100%;">

<tr>
<td style="background:linear-gradient(120deg,#1a23d8,#3f5bff,#6f8dff);padding:20px;text-align:center;color:#fff;">
    <img src="https://yiraappdev.blob.core.windows.net/adminuploadedfiles/yiraai.svg" width="70"/>
    <h2 style="margin:10px 0 0;">Yira</h2>
    <div style="font-size:12px;">Powering Healthcare with Clinicx</div>
</td>
</tr>

<tr>
<td style="padding:25px;color:#333;font-size:14px;line-height:1.6;">
    <h1 style="text-align:center;color:#1920d9;font-size:20px;">Password Updated</h1>

    <p>Hi <strong>${user.FirstName || 'User'}</strong>,</p>

    <p>Your password for the account registered with mobile/email has been successfully changed.</p>

    <p>If you didn't request this change, please contact support immediately.</p>

    <p>
        Regards,<br/>
        <strong>Yira Health Tech Team</strong><br/>
        contact@yira.ai
    </p>
</td>
</tr>

<tr>
<td style="background:#f4f6fb;text-align:center;padding:15px;font-size:11px;color:#777;">
    © 2026 Yira Health Tech Pvt Ltd.
</td>
</tr>

</table>

</body>
</html>
                `
            }).catch(err => console.error("[AuthService] Failed to send password change confirmation email:", err));
        }

        return { message: "Password has been reset successfully" };
    }

    async verifyForgotPasswordOTP(
        identity: string,
        sessionId: string,
        otp: string,
        contactType?: string,
        countryCode?: string
    ): Promise<{ success: boolean; message: string; contact: string; contactType: OTPType; countryCode: string | null }> {
        const isEmail = contactType 
            ? String(contactType).toUpperCase() === "EMAIL"
            : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity);

        const verification = await otpService.verifyOTP(
            identity,
            sessionId,
            otp,
            OTPPurpose.PASSWORD_RESET,
            isEmail ? undefined : countryCode
        );

        if (!verification.success) {
            throw new Error(verification.message);
        }

        let resolvedCountryCode = countryCode || null;
        let lookupIdentity = identity;
        if (!isEmail) {
            if (countryCode && identity.startsWith(countryCode)) {
                lookupIdentity = identity.substring(countryCode.length);
            } else if (identity.startsWith("91")) {
                lookupIdentity = identity.substring(2);
            }
            if (!resolvedCountryCode) {
                const user = await mobileAuthRepository.findPrimaryUser(lookupIdentity);
                if (user) {
                    resolvedCountryCode = user.CountryCode || null;
                }
            }
        }

        return { 
            success: true, 
            message: "OTP verified successfully",
            contact: lookupIdentity,
            contactType: isEmail ? OTPType.EMAIL : OTPType.MOBILE,
            countryCode: isEmail ? null : resolvedCountryCode
        };
    }

    async changePasswordWithOTPVerification(
        identity: string,
        newPassword: string,
        contactType?: string,
        countryCode?: string
    ): Promise<{ message: string }> {
        const isEmail = contactType 
            ? String(contactType).toUpperCase() === "EMAIL"
            : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity);

        let lookupIdentity = identity;
        if (!isEmail) {
            if (countryCode && identity.startsWith(countryCode)) {
                lookupIdentity = identity.substring(countryCode.length);
            } else if (identity.startsWith("91")) {
                lookupIdentity = identity.substring(2);
            }
        }

        // Verify that OTP was recently verified (within last 10 minutes)
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
        const verifiedOtp = await AppDataSource.getRepository(UserOTP).findOne({
            where: {
                Contact: lookupIdentity,
                IsExpired: true,
                Purpose: OTPPurpose.PASSWORD_RESET
            },
            order: { UpdatedDate: "DESC" }
        });

        if (!verifiedOtp || !verifiedOtp.UpdatedDate || verifiedOtp.UpdatedDate < tenMinutesAgo) {
            throw new Error("OTP verification is required before resetting password");
        }

        // Fetch primary user
        const user = await mobileAuthRepository.findPrimaryUser(lookupIdentity);
        if (!user) {
            throw new Error("User not found");
        }

        // Update password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        user.PasswordHash = hashedPassword;
        user.UpdatedAt = new Date();
        await mobileAuthRepository.saveUser(user);

        // Revoke active tokens/sessions for safety
        await tokenRepository.revokeAllUserTokens(user.Id);

        // Send email notification if user has a registered email address
        if (user.Email) {
            mailService.sendMail({
                to: user.Email,
                subject: "Yira - Password Changed Successfully",
                body: `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Password Changed</title>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:Segoe UI, Arial,sans-serif;">

<table style="max-width:520px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.08);width:100%;">

<tr>
<td style="background:linear-gradient(120deg,#1a23d8,#3f5bff,#6f8dff);padding:20px;text-align:center;color:#fff;">
    <img src="https://yiraappdev.blob.core.windows.net/adminuploadedfiles/yiraai.svg" width="70"/>
    <h2 style="margin:10px 0 0;">Yira</h2>
    <div style="font-size:12px;">Powering Healthcare with Clinicx</div>
</td>
</tr>

<tr>
<td style="padding:25px;color:#333;font-size:14px;line-height:1.6;">
    <h1 style="text-align:center;color:#1920d9;font-size:20px;">Password Updated</h1>

    <p>Hi <strong>${user.FirstName || 'User'}</strong>,</p>

    <p>Your password for the account registered with mobile/email has been successfully changed.</p>

    <p>If you didn't request this change, please contact support immediately.</p>

    <p>
        Regards,<br/>
        <strong>Yira Health Tech Team</strong><br/>
        contact@yira.ai
    </p>
</td>
</tr>

<tr>
<td style="background:#f4f6fb;text-align:center;padding:15px;font-size:11px;color:#777;">
    © 2026 Yira Health Tech Pvt Ltd.
</td>
</tr>

</table>

</body>
</html>
                `
            }).catch(err => console.error("[AuthService] Failed to send password change confirmation email:", err));
        }

        return { message: "Password has been reset successfully" };
    }
}

export const mobileAuthService = new MobileAuthService();

function formatDOB(dob: any): string | null {
    if (!dob) return null;
    if (typeof dob === 'string') {
        if (/^\d{2}-\d{2}-\d{4}$/.test(dob)) {
            return dob;
        }
        const match = dob.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (match) {
            return `${match[3]}-${match[2]}-${match[1]}`;
        }
    }
    try {
        const dateObj = new Date(dob);
        if (isNaN(dateObj.getTime())) {
            return typeof dob === 'string' ? dob : null;
        }
        const day = String(dateObj.getUTCDate()).padStart(2, '0');
        const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
        const year = dateObj.getUTCFullYear();
        return `${day}-${month}-${year}`;
    } catch {
        return typeof dob === 'string' ? dob : null;
    }
}

export function getNavigationId(roleId: string | null | undefined): string | null {
    if (!roleId) return null;
    const roleIdUpper = roleId.toUpperCase();
    switch (roleIdUpper) {
        case "4FC67429-28AE-4106-93EF-436228282ED0": // Patient
            return "1";
        case "FE80173F-9DB3-4703-84A8-5C23E7CC493C": // Provider
            return "2";
        case "3956F98D-D835-4204-8D5B-72870E57FF76": // Front Desk
            return "3";
        case "FFE1811D-6200-407C-9BDD-3B89FA1BAF2B": // Hospital Admin
            return "4";
        case "6F92E889-9844-4C8F-A9E7-5A456F12A9C7": // Org Admin
            return "5";
        case "F6C3292F-BB06-4F43-9962-988E23087FD5": // Yira System Admin
            return "6";
        default:
            return null;
    }
}
