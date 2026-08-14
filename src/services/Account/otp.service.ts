import { userOTPRepository } from "../../repositories/Account/userotp.repository.js";
import { userRepository } from "../../repositories/Account/user.repository.js";
import { mailService } from "../../services/Mail/mail.service.js";
import { smsService } from "../../services/Common/sms.service.js";
import { whatsappService } from "../../services/Common/whatsapp.service.js";
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
        customData?: Record<string, any>,
        channel?: "sms" | "whatsapp",
        isMobile?: boolean
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

        /*
        // Check daily attempt limit (Max 20 OTPs for mobile login, 5 OTPs for other purposes/channels per 24 hours)
        const limit = (isMobile && purpose === OTPPurpose.LOGIN) ? 20 : 5;
        const dailyAttempts = await userOTPRepository.countDailyAttempts(finalContact, purpose);
        if (dailyAttempts >= limit) {
            throw new Error("Maximum OTP attempts reached. Please try again after 24 hours.");
        }
        */

        // Optional: Find user for personalized email (don't throw error if not found)
        let user;
        if (isEmail) {
            user = await userRepository.findPrimaryByEmail(finalContact);
        } else {
            // Also clean phone prefix for lookup if needed
            let phoneLookup = finalContact;
            const cleanPhone = finalContact.startsWith("+") ? finalContact.slice(1) : finalContact;
            if (cleanPhone.startsWith("91") && cleanPhone.length === 12) {
                phoneLookup = cleanPhone.substring(2);
            }
            user = await userRepository.findPrimaryByPhone(phoneLookup);
        }

        // Validate patient role before generating/sending OTP if purpose is LOGIN
        if (purpose === OTPPurpose.LOGIN) {
            if (!user) {
                throw new Error("No account found with this details. Please register first.");
            }

            const { userRoleRepository } = await import("../../repositories/Account/userrole.repository.js");
            const roles = await userRoleRepository.findAllByUserId(user.Id);
            const PATIENT_ROLE_ID = "4FC67429-28AE-4106-93EF-436228282ED0";
            const PROVIDER_ROLE_ID = "FE80173F-9DB3-4703-84A8-5C23E7CC493C";
            
            const hasActiveMobileRole = roles.some(r => 
                (r.RoleId.toUpperCase() === PATIENT_ROLE_ID.toUpperCase() || 
                 r.RoleId.toUpperCase() === PROVIDER_ROLE_ID.toUpperCase()) && 
                r.Status && 
                !r.IsDeleted
            );

            if (!hasActiveMobileRole) {
                throw new Error("No patient account found for this mobile number.");
            }
        }

        // Create OTP record in repository
        const { otp, sessionId, expiryTime, contactType, message } = await userOTPRepository.sendOTP(finalContact, purpose, finalCountryCode);

        // Map purpose to default template if not provided
        let emailTemplate = templateCode;
        if (!emailTemplate) {
            switch (purpose) {
                case OTPPurpose.PASSWORD_RESET: emailTemplate = "EMAIL_OTP_VERIFICATION"; break;
                case OTPPurpose.LOGIN: emailTemplate = "LOGIN_OTP"; break;
                default: emailTemplate = "EMAIL_OTP_VERIFICATION";
            }
        }

        // Send OTP via email, SMS, or WhatsApp
        if (contactType === OTPType.EMAIL) {
            try {
                await mailService.sendDynamicEmail(emailTemplate, finalContact, {
                    FirstName: user?.FirstName || "User",
                    LastName: user?.LastName || "",
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
            if (channel === "whatsapp") {
                try {
                    const normalizedTo = fullMobileForSMS.startsWith("+") ? fullMobileForSMS.slice(1) : fullMobileForSMS;
                    const components = [
                        {
                            type: "body",
                            parameters: [
                                {
                                    type: "text",
                                    text: otp
                                }
                            ]
                        },
                        {
                            type: "button",
                            sub_type: "url",
                            index: 0,
                            parameters: [
                                {
                                    type: "text",
                                    text: otp
                                }
                            ]
                        }
                    ];
                    console.log(`[OTP] Sending WhatsApp template message to ${normalizedTo} with OTP ${otp}...`);
                    await whatsappService.sendTemplateMessage(normalizedTo, "auth", "en", components);
                } catch (whatsappError: any) {
                    console.error(`[OTP] Failed to send WhatsApp message to ${fullMobileForSMS}:`, whatsappError);
                    throw new Error(`Failed to send OTP via WhatsApp: ${whatsappError.message}`);
                }
            } else {
                try {
                    // Send OTP via SMS (using full mobile number including 91)
                    await smsService.sendOTP(fullMobileForSMS, otp);
                } catch (smsError) {
                    console.error(`[OTP] Failed to send SMS to ${fullMobileForSMS}:`, smsError);
                }
            }
        }

        return {
            sessionId,
            contactType,
            message
        };
    }

    /**
     * Resends OTP to a contact (Email or Mobile).
     * This marks any existing unexpired OTPs for this contact as expired before sending a new one.
     */
    async resendOTP(
        contact: string,
        purpose: OTPPurpose = OTPPurpose.VERIFICATION,
        countryCode?: string,
        channel?: "sms" | "whatsapp",
        isMobile?: boolean
    ): Promise<{ sessionId: string, contactType: OTPType, message: string }> {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const isEmail = emailRegex.test(contact);

        let lookupContact = contact;
        if (!isEmail) {
            if (contact.startsWith("91") && !countryCode) {
                lookupContact = contact.substring(2);
            } else if (countryCode) {
                lookupContact = contact;
            }
        }

        // Find existing unexpired OTP and mark it as expired
        const existingOTP = await userOTPRepository.findLatestByContact(lookupContact);
        if (existingOTP && existingOTP.SessionId) {
            await userOTPRepository.markAsExpired(existingOTP.SessionId);
        }

        // Send a new OTP
        return await this.sendOTP(contact, purpose, countryCode, undefined, undefined, channel, isMobile);
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

        // Normalize contact for lookup (strip country code prefix if present)
        let lookupContact = contact;
        if (!isEmail) {
            if (countryCode && contact.startsWith(countryCode)) {
                lookupContact = contact.substring(countryCode.length);
            } else if (contact.startsWith("91")) {
                lookupContact = contact.substring(2);
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
            try {
                let userId: string | null = null;
                if (isEmail) {
                    const user = await userRepository.findPrimaryByEmail(lookupContact);
                    if (user) {
                        userId = user.Id;
                        if (!user.IsEmailVerified) {
                            await userRepository.updateUser(userId, { IsEmailVerified: true });
                            console.log(`[OTP] Email verified for user ${userId}`);
                        } else {
                            console.log(`[OTP] Email already verified for user ${userId}`);
                        }
                    } else {
                        console.warn(`[OTP] No user found with email: ${lookupContact}`);
                    }
                } else {
                    // Only update the primary user — sub-accounts share the same phone but should not be marked verified
                    let user = await userRepository.findPrimaryByPhone(lookupContact);
                    if (!user && countryCode) {
                        user = await userRepository.findPrimaryByPhone(countryCode + lookupContact);
                    }
                    if (user) {
                        userId = user.Id;
                        if (!user.IsMobileVerified) {
                            await userRepository.updateUser(userId, { IsMobileVerified: true });
                            console.log(`[OTP] Mobile verified for primary user ${userId}`);
                        } else {
                            console.log(`[OTP] Mobile already verified for primary user ${userId}`);
                        }
                    } else {
                        console.warn(`[OTP] No primary user found with phone: ${lookupContact}`);
                    }
                }
            } catch (updateError) {
                console.error(`[OTP] Failed to update verification status:`, updateError);
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
