import type { Request, Response } from "express";
import { mobileAuthService, getNavigationId } from "../services/mobile-auth.service.js";
import { authService } from "../../../services/Account/auth.service.js";
import { ApiResponse } from "../../../utils/response.utils.js";
import { userDeviceService } from "../services/userdevice.service.js";
import { verifyRefreshToken } from "../../../utils/jwt.utils.js";
import { tokenRepository } from "../../../repositories/Account/token.repository.js";

/**
 * Handles mobile user login requests.
 * Email: authenticates with password directly.
 * Mobile: verifies OTP using sessionId and password (which is the OTP code).
 */
export const login = async (req: Request, res: Response) => {
    try {
        const { identity, password, loginType, type, sessionId, countryCode } = req.body;
        if (!identity) {
            return res.status(400).json({
                status: false,
                message: "Identity is required",
                code: "IDENTITY_REQUIRED",
                data: { code: "IDENTITY_REQUIRED" }
            });
        }

        const deviceInfo = req.headers["x-device-info"] as string;
        const ipAddress = req.headers["x-ip-address"] as string;

        const resolvedType = loginType || type || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity) ? "email" : "mobile");

        const result = await mobileAuthService.login(
            identity,
            password,
            resolvedType,
            sessionId,
            countryCode,
            deviceInfo,
            ipAddress
        );

        return res.json(ApiResponse.success(result, "Login successful! Welcome back."));
    } catch (error: any) {
        let code = "AUTHENTICATION_FAILED";
        let status = 400;

        if (error.message === "Invalid emailid") {
            code = "INVALID_EMAILID";
            status = 200;
        } else if (error.message === "Invalid password") {
            code = "INVALID_PASSWORD";
            status = 200;
        } else if (error.message === "Invalid email format") {
            code = "INVALID_EMAIL";
            status = 400;
        } else if (error.message === "Password is required for email login") {
            code = "PASSWORD_REQUIRED";
            status = 400;
        } else if (error.message === "Account setup incomplete. Please contact support.") {
            code = "INCOMPLETE_SETUP";
            status = 400;
        } else if (error.message === "Session ID is required for mobile OTP login") {
            code = "SESSION_ID_REQUIRED";
            status = 400;
        } else if (error.message === "OTP is required for mobile OTP login") {
            code = "OTP_REQUIRED";
            status = 400;
        } else if (error.message === "Invalid OTP. Please check the code and try again.") {
            code = "INVALID_OTP";
            status = 400;
        } else if (error.message.includes("Access denied")) {
            code = "ACCESS_DENIED";
            status = 400;
        }

        const responseBody: any = {
            status: false,
            message: error.message
        };

        if (status !== 200) {
            responseBody.code = code;
            responseBody.data = { code };
        }

        return res.status(status).json(responseBody);
    }
};

/**
 * Sends OTP to a mobile phone user if they exist and are active with Patient/Provider roles.
 * Supports resending via optional `isResend` / `resend` body flag.
 */
export const sendOTP = async (req: Request, res: Response) => {
    const { identity, countryCode, isResend, resend } = req.body;
    const isResendFlag = isResend === true || resend === true;
    try {
        if (!identity) {
            return res.status(400).json({
                status: false,
                message: "Identity (phone number) is required",
                code: "IDENTITY_REQUIRED",
                data: { code: "IDENTITY_REQUIRED" }
            });
        }

        const result = await mobileAuthService.sendOTP(identity, countryCode, isResendFlag);
        const successMessage = isResendFlag ? "OTP resent successfully!" : "OTP sent successfully!";
        return res.json(ApiResponse.success(result, successMessage));
    } catch (error: any) {
        let status = 400;
        let code = "OTP_SEND_FAILED";
        let message = error.message;

        if (error.message === "User not registered") {
            status = 404;
            code = "USER_NOT_REGISTERED";
        } else if (error.message.includes("Access denied")) {
            status = 400;
            code = "ACCESS_DENIED";
        } else if (error.message === "User account is inactive") {
            status = 400;
            code = "INACTIVE_USER";
        } else if (error.message === "Email cannot be used for OTP login") {
            status = 400;
            code = "EMAIL_NOT_ALLOWED";
        } else if (error.message === "No phone number found for this user") {
            status = 400;
            code = "PHONE_NOT_FOUND";
        } else if (error.message.includes("Maximum OTP attempts reached")) {
            status = 400;
            code = "OTP_LIMIT_EXCEEDED";
        } else {
            message = isResendFlag
                ? "Could not resend OTP. Please try again."
                : "Failed to send OTP. Please try again later.";
            code = isResendFlag ? "OTP_RESEND_FAILED" : "OTP_SEND_FAILED";
        }

        return res.status(status).json({
            status: false,
            message,
            code,
            data: { code }
        });
    }
};

/**
 * Handles resending OTP for mobile logins (legacy endpoint wrapper).
 */
export const resendOTP = async (req: Request, res: Response) => {
    try {
        const { contact, countryCode } = req.body;
        if (!contact) {
            return res.status(400).json({
                status: false,
                message: "Contact (phone number) is required",
                code: "CONTACT_REQUIRED",
                data: { code: "CONTACT_REQUIRED" }
            });
        }

        const result = await mobileAuthService.sendOTP(contact, countryCode, true);
        return res.json(ApiResponse.success(result, "OTP resent successfully!"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: "Could not resend OTP. Please try again.",
            code: "OTP_RESEND_FAILED",
            data: { code: "OTP_RESEND_FAILED" }
        });
    }
};

/**
 * Verifies mobile OTP and issues authentication tokens (legacy endpoint wrapper).
 */
export const verifyLogin = async (req: Request, res: Response) => {
    try {
        const { contact, sessionId, otp, countryCode } = req.body;
        if (!contact || !sessionId || !otp) {
            return res.status(400).json({
                status: false,
                message: "Contact, sessionId, and OTP are required",
                code: "MISSING_FIELDS",
                data: { code: "MISSING_FIELDS" }
            });
        }

        const deviceInfo = req.headers["x-device-info"] as string;
        const ipAddress = req.headers["x-ip-address"] as string;

        const result = await mobileAuthService.login(
            contact,
            otp,
            "mobile",
            sessionId,
            countryCode,
            deviceInfo,
            ipAddress
        );
        return res.json(ApiResponse.success(result, "Login successful! Welcome back."));
    } catch (error: any) {
        let code = "AUTHENTICATION_FAILED";
        let status = 400;
        if (error.message === "Invalid OTP. Please check the code and try again.") {
            code = "INVALID_OTP";
        } else if (error.message.includes("Access denied")) {
            code = "ACCESS_DENIED";
            status = 400;
        }
        return res.status(status).json({
            status: false,
            message: error.message,
            code,
            data: { code }
        });
    }
};

/**
 * Handles mobile token refresh requests.
 */
export const refreshToken = async (req: Request, res: Response) => {
    try {
        const { refreshToken } = req.body;
        const result = await mobileAuthService.refreshToken(refreshToken);
        return res.json(ApiResponse.success(result, "Token refreshed successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message,
            code: "REFRESH_TOKEN_FAILED",
            data: { code: "REFRESH_TOKEN_FAILED" }
        });
    }
};

/**
 * Handles mobile user logout.
 */
export const logout = async (req: Request, res: Response) => {
    try {
        const { refreshToken, fcmToken, deviceId, one, logoutAll, allDevices } = req.body;

        let userId: string | null = null;
        if (refreshToken) {
            // First decode using JWT utility to see if payload is valid
            const payload = verifyRefreshToken(refreshToken);
            if (payload && payload.userId) {
                userId = payload.userId;
            } else {
                // If JWT verify fails (e.g. expired token), look up in DB to find associated UserId
                const tokenRecord = await tokenRepository.findByRefreshToken(refreshToken);
                if (tokenRecord) {
                    userId = tokenRecord.UserId;
                }
            }
        }

        // Call the standard authService logout logic to revoke the session
        if (refreshToken) {
            await authService.logout(refreshToken);
        }

        // Deactivate push notification devices if we identified the user
        if (userId) {
            // Dual-mode logic:
            // Single device logout: active only when 'one' is explicitly true.
            // All devices logout: active when 'one' is not true, OR if logoutAll/allDevices is true.
            const isSingleDeviceLogout = (one === true);

            await userDeviceService.deactivateDevices(userId, isSingleDeviceLogout, fcmToken, deviceId);
        }

        return res.status(200).json(ApiResponse.success(null, "Logged out successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message,
            code: "LOGOUT_FAILED",
            data: { code: "LOGOUT_FAILED" }
        });
    }
};

/**
 * Handles mobile forgot password requests.
 */
export const forgotPassword = async (req: Request, res: Response) => {
    try {
        const { identity, contactType, isResend, countryCode } = req.body;
        if (!identity) {
            return res.status(200).json({
                status: false,
                message: "identity is required"
            });
        }
        if (!contactType) {
            return res.status(200).json({
                status: false,
                message: "contactType is required"
            });
        }

        const normalizedType = String(contactType).toLowerCase();
        if (normalizedType !== "email" && normalizedType !== "mobile") {
            return res.status(200).json({
                status: false,
                message: "contactType must be 'email' or 'mobile'"
            });
        }

        const isEmail = (normalizedType === "email");

        if (!isEmail && !countryCode) {
            return res.status(200).json({
                status: false,
                message: "Country code (countryCode) is required for mobile recovery"
            });
        }

        const result = await mobileAuthService.sendForgotPasswordOTP(identity, contactType, isResend, countryCode);
        return res.json(ApiResponse.success(result, "OTP sent successfully"));
    } catch (error: any) {
        return res.status(200).json({
            status: false,
            message: error.message
        });
    }
};

/**
 * Handles mobile password reset using OTP.
 */
export const resetPassword = async (req: Request, res: Response) => {
    try {
        const { identity, sessionId, otp, newPassword, contactType, countryCode } = req.body;
        if (!identity || !sessionId || !otp || !newPassword) {
            return res.status(200).json({
                status: false,
                message: "Identity, sessionId, otp, and newPassword are required"
            });
        }

        const isEmail = contactType
            ? String(contactType).toUpperCase() === "EMAIL"
            : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity);

        if (!isEmail && !countryCode) {
            return res.status(200).json({
                status: false,
                message: "Country code (countryCode) is required for mobile recovery"
            });
        }

        if (newPassword.length < 6) {
            return res.status(200).json({
                status: false,
                message: "Password must be at least 6 characters"
            });
        }
        const result = await mobileAuthService.resetPasswordWithOTP(identity, sessionId, otp, newPassword, contactType, countryCode);
        return res.json(ApiResponse.success(null, result.message));
    } catch (error: any) {
        return res.status(200).json({
            status: false,
            message: error.message
        });
    }
};

/**
 * Fetches organizations and hospitals associated with a user's role.
 */
export const getRoleDetails = async (req: Request, res: Response) => {
    try {
        const { userId, roleId } = req.query;

        if (!userId) {
            return res.status(400).json({
                status: false,
                message: "userId is required",
                code: "USER_ID_REQUIRED",
                data: { code: "USER_ID_REQUIRED" }
            });
        }
        if (!roleId) {
            return res.status(400).json({
                status: false,
                message: "roleId is required",
                code: "ROLE_ID_REQUIRED",
                data: { code: "ROLE_ID_REQUIRED" }
            });
        }

        const result = await mobileAuthService.getUserOrganizationHospitals(
            String(userId),
            String(roleId)
        );

        return res.json(ApiResponse.success(result, "Organizations and hospitals fetched successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message,
            code: "GET_ROLE_DETAILS_FAILED",
            data: { code: "GET_ROLE_DETAILS_FAILED" }
        });
    }
};

/**
 * Updates the user's latest session context.
 */
export const updateLatestContext = async (req: Request, res: Response) => {
    try {
        const { userId, latestRoleId, latestOrgId, latestHospitalId } = req.body || {};

        // Resolve authenticated user ID from token or request body
        const resolvedUserId = userId || (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id || (req as any).userId;

        if (!resolvedUserId) {
            return res.status(400).json({
                status: false,
                message: "User ID is required",
                code: "USER_ID_REQUIRED",
                data: { code: "USER_ID_REQUIRED" }
            });
        }

        const updatedUser = await mobileAuthService.updateLatestContext(
            resolvedUserId,
            latestRoleId,
            latestOrgId ? parseInt(latestOrgId) : undefined,
            latestHospitalId ? parseInt(latestHospitalId) : undefined
        );

        return res.json(ApiResponse.success({
            userId: updatedUser.Id,
            latestRoleId: updatedUser.LatestRoleId,
            latestOrgId: updatedUser.LatestOrgId,
            latestHospitalId: updatedUser.LatestHospitalId,
            navigationId: getNavigationId(updatedUser.LatestRoleId)
        }, "Latest context updated successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message,
            code: "CONTEXT_UPDATE_FAILED",
            data: { code: "CONTEXT_UPDATE_FAILED" }
        });
    }
};

/**
 * Gets the profile and recent context details of the authenticated user.
 */
export const getUserData = async (req: Request, res: Response) => {
    try {
        const userId = req.body?.userId || (req.query.userId as string) || (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id || (req as any).userId;
        const deviceId = req.body?.deviceId || (req.query.deviceId as string);

        if (!userId) {
            return res.status(400).json({
                status: false,
                message: "User ID is required",
                code: "USER_ID_REQUIRED",
                data: { code: "USER_ID_REQUIRED" }
            });
        }

        const userData = await mobileAuthService.getUserData(userId, deviceId);
        return res.json(ApiResponse.success(userData, "User details fetched successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message,
            code: "GET_USER_DATA_FAILED",
            data: { code: "GET_USER_DATA_FAILED" }
        });
    }
};

/**
 * Verifies password reset OTP for mobile users.
 */
export const verifyOTP = async (req: Request, res: Response) => {
    try {
        const { identity, sessionId, otp, contactType, countryCode } = req.body;
        if (!identity) {
            return res.status(200).json({
                status: false,
                message: "identity is required"
            });
        }
        if (!contactType) {
            return res.status(200).json({
                status: false,
                message: "contactType is required"
            });
        }
        if (!sessionId) {
            return res.status(200).json({
                status: false,
                message: "sessionId is required"
            });
        }
        if (!otp) {
            return res.status(200).json({
                status: false,
                message: "otp is required"
            });
        }

        const normalizedType = String(contactType).toLowerCase();
        if (normalizedType !== "email" && normalizedType !== "mobile") {
            return res.status(200).json({
                status: false,
                message: "contactType must be 'email' or 'mobile'"
            });
        }

        const isEmail = (normalizedType === "email");

        if (!isEmail && !countryCode) {
            return res.status(200).json({
                status: false,
                message: "Country code (countryCode) is required for mobile recovery"
            });
        }

        const result = await mobileAuthService.verifyForgotPasswordOTP(identity, sessionId, otp, contactType, countryCode);
        return res.json(ApiResponse.success(result, result.message));
    } catch (error: any) {
        return res.status(200).json({
            status: false,
            message: error.message
        });
    }
};

/**
 * Handles mobile password reset after successful OTP verification.
 */
export const changePassword = async (req: Request, res: Response) => {
    try {
        const { identity, newPassword, confirmPassword, contactType, countryCode } = req.body;
        if (!identity) {
            return res.status(200).json({
                status: false,
                message: "identity is required"
            });
        }
        if (!contactType) {
            return res.status(200).json({
                status: false,
                message: "contactType is required"
            });
        }
        if (!newPassword) {
            return res.status(200).json({
                status: false,
                message: "newPassword is required"
            });
        }
        if (!confirmPassword) {
            return res.status(200).json({
                status: false,
                message: "confirmPassword is required"
            });
        }

        if (newPassword !== confirmPassword) {
            return res.status(200).json({
                status: false,
                message: "newPassword and confirmPassword do not match"
            });
        }

        const normalizedType = String(contactType).toLowerCase();
        if (normalizedType !== "email" && normalizedType !== "mobile") {
            return res.status(200).json({
                status: false,
                message: "contactType must be 'email' or 'mobile'"
            });
        }

        const isEmail = (normalizedType === "email");

        if (!isEmail && !countryCode) {
            return res.status(200).json({
                status: false,
                message: "Country code (countryCode) is required for mobile recovery"
            });
        }

        if (newPassword.length < 6) {
            return res.status(200).json({
                status: false,
                message: "Password must be at least 6 characters"
            });
        }

        const result = await mobileAuthService.changePasswordWithOTPVerification(identity, newPassword, contactType, countryCode);
        return res.json(ApiResponse.success(null, result.message));
    } catch (error: any) {
        return res.status(200).json({
            status: false,
            message: error.message
        });
    }
};


