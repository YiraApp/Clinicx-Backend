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

        let lookupIdentity = identity;
        if (countryCode && identity.startsWith(countryCode)) {
            lookupIdentity = identity.substring(countryCode.length);
        } else if (identity.startsWith("91")) {
            lookupIdentity = identity.substring(2);
        }

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
                throw new Error("Authentication failed. Please try again.");
            }

            if (!user.Status) {
                throw new Error("Authentication failed. Please try again.");
            }

            if (!password) {
                throw new Error("Password is required for email login");
            }

            if (!user.PasswordHash) {
                throw new Error("Account setup incomplete. Please contact support.");
            }

            const isMatch = await bcrypt.compare(password, user.PasswordHash);
            if (!isMatch) {
                throw new Error("Authentication failed. Please try again.");
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
    async getUserData(userId: string): Promise<{
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

        return {
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
            navigationId: getNavigationId(user.LatestRoleId)
        };
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
