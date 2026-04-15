import { userOTPRepository } from "../../repositories/Account/userotp.repository.js";
import { userRepository } from "../../repositories/Account/user.repository.js";
import { mailService } from "../../services/Mail/mail.service.js";
import { smsService } from "../../services/Common/sms.service.js";
import { OTPType, OTPPurpose } from "../../enums/OTPType.enum.js";

/**
 * Global Service for OTP operations (Email & Mobile).
 */
export class OTPService {
    /**
     * Sends OTP to a contact (Email or Mobile).
     * @param contact Email or phone number
     * @param purpose OTP purpose
     * @param templateCode Optional custom email template code
     * @param customData Optional additional data for the template
     */
    async sendOTP(
        contact: string, 
        purpose: OTPPurpose = OTPPurpose.VERIFICATION, 
        countryCode?: string,
        templateCode?: string,
        customData?: Record<string, any>
    ): Promise<{ sessionId: string, contactType: OTPType, message: string }> {
        // Detect if contact is email or phone
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const isEmail = emailRegex.test(contact);

        // Normalize contact and extract country code for mobile
        let finalContact = contact;
        let finalCountryCode = countryCode;
        let fullMobileForSMS = contact;

        if (!isEmail) {
            // If contact starts with 91 but no countryCode was passed, extract it
            if (contact.startsWith("91") && !finalCountryCode) {
                finalCountryCode = "91";
                finalContact = contact.substring(2);
            } 
            // If countryCode was passed separately, ensure finalContact is clean and fullMobile is combined
            else if (finalCountryCode) {
                finalContact = contact; // Assuming it's the 10-digit number
                fullMobileForSMS = finalCountryCode + contact;
            }
        }

        // Optional: Find user for personalized email (don't throw error if not found)
        let user;
        if (isEmail) {
            user = await userRepository.findByEmail(finalContact);
        } else {
            user = await userRepository.findPrimaryByPhone(finalContact);
        }

        // Create OTP record in repository
        const { otp, sessionId, expiryTime, contactType, message } = await userOTPRepository.sendOTP(finalContact, purpose, finalCountryCode);

        // Map purpose to default template if not provided
        let emailTemplate = templateCode;
        if (!emailTemplate) {
            switch (purpose) {
                case OTPPurpose.PASSWORD_RESET: emailTemplate = "PASSWORD_RESET_OTP"; break;
                case OTPPurpose.LOGIN: emailTemplate = "LOGIN_OTP"; break;
                default: emailTemplate = "EMAIL_OTP_VERIFICATION";
            }
        }

        // Send OTP via email or SMS
        if (contactType === OTPType.EMAIL) {
            try {
                await mailService.sendDynamicEmail(emailTemplate, finalContact, {
                    FirstName: user?.FirstName || "User",
                    OTP: otp,
                    ExpiryMinutes: 10,
                    SessionId: sessionId,
                    Purpose: purpose,
                    ...customData
                });
            } catch (mailError) {
                console.error(`[OTP] Failed to send email to ${finalContact} using template ${emailTemplate}:`, mailError);
                throw new Error("Failed to send OTP email. Please try again.");
            }
        } else {
            try {
                // Send OTP via SMS (using full mobile number including 91)
                await smsService.sendOTP(fullMobileForSMS, otp);
            } catch (smsError) {
                console.error(`[OTP] Failed to send SMS to ${fullMobileForSMS}:`, smsError);
            }
        }

        return {
            sessionId,
            contactType,
            message
        };
    }

    /**
     * Verifies OTP and optionally updates User verification status.
     */
    async verifyOTP(
        contact: string, 
        sessionId: string, 
        otp: string, 
        purpose: OTPPurpose = OTPPurpose.VERIFICATION,
        countryCode?: string
    ): Promise<{ 
        success: boolean, 
        isVerified: boolean, 
        verifiedField: 'email' | 'mobile' | null,
        message: string 
    }> {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const isEmail = emailRegex.test(contact);

        // Normalize contact for lookup (strip 91 if mobile or use provided contact if countryCode exists)
        let lookupContact = contact;
        if (!isEmail) {
            if (contact.startsWith("91") && !countryCode) {
                lookupContact = contact.substring(2);
            } else if (countryCode) {
                lookupContact = contact; // If countryCode passed, contact is assumed to be 10 digits
            }
        }

        // Verify OTP using the repository logic
        const verification = await userOTPRepository.verifyOTP(sessionId, lookupContact, otp, purpose);

        if (!verification.success) {
            return {
                success: false,
                isVerified: false,
                verifiedField: null,
                message: verification.message
            };
        }

        // 2. Post-verification: Update User table ONLY if the purpose is VERIFICATION
        let verifiedField: 'email' | 'mobile' = isEmail ? 'email' : 'mobile';

        if (purpose === OTPPurpose.VERIFICATION) {
            let user;
            if (isEmail) {
                user = await userRepository.findByEmail(lookupContact);
                if (user && !user.IsEmailVerified) {
                    user.IsEmailVerified = true;
                    user.UpdatedAt = new Date();
                    user.UpdatedBy = "SYSTEM_OTP";
                    await userRepository.save(user);
                }
            } else {
                // Look up user by the 10-digit number
                user = await userRepository.findPrimaryByPhone(lookupContact);

                if (user && !user.IsMobileVerified) {
                    user.IsMobileVerified = true;
                    user.UpdatedAt = new Date();
                    user.UpdatedBy = "SYSTEM_OTP";
                    await userRepository.save(user);
                }
            }
        }

        return {
            success: true,
            isVerified: true,
            verifiedField,
            message: `${isEmail ? 'Email' : 'Mobile'} verified successfully.`
        };
    }
}

export const otpService = new OTPService();
