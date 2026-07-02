import { AppDataSource } from "../../config/database.js";
import { UserOTP } from "../../models/Account/userotp.model.js";
import { OTPType, OTPPurpose } from "../../enums/OTPType.enum.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Repository implementation for UserOTP entity.
 * Handles OTP generation, verification, and validation for any contact type.
 */
export class UserOTPRepository {
    private repo = AppDataSource.getRepository(UserOTP);

    /**
     * Detects contact type (email or mobile) based on format
     */
    private detectContactType(contact: string): OTPType {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(contact) ? OTPType.EMAIL : OTPType.MOBILE;
    }

    /**
     * Creates and saves a new OTP record for any contact type
     * @param contact Email or phone number
     * @param purpose Purpose of OTP (from OTPPurpose enum)
     * @returns OTP, sessionId, expiryTime, contactType, and message
     */
    async sendOTP(contact: string, purpose: OTPPurpose = OTPPurpose.VERIFICATION, countryCode?: string): Promise<{ 
        otp: string, 
        sessionId: string, 
        expiryTime: Date, 
        contactType: OTPType,
        message: string 
    }> {
        // Detect contact type automatically
        const contactType = this.detectContactType(contact);

        // Generate random 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        // Generate unique session ID to prevent OTP reuse across sessions
        const sessionId = uuidv4();
        
        // Set expiry time to 10 minutes from now to prevent old OTP usage
        const expiryTime = new Date(Date.now() + 10 * 60 * 1000);

        const userOTP = new UserOTP();
        userOTP.Contact = contact;
        userOTP.OTP = otp;
        userOTP.SessionId = sessionId;
        userOTP.OTPType = contactType;
        userOTP.Purpose = purpose;
        userOTP.ExpiryTime = expiryTime;
        userOTP.IsExpired = false;
        userOTP.AttemptCount = 0;
        userOTP.CountryCode = countryCode ?? null;
        userOTP.CreatedBy = "SYSTEM";
        userOTP.UpdatedBy = "SYSTEM";

        await this.repo.save(userOTP);

        const contactLabel = contactType === OTPType.EMAIL ? 'email' : 'phone number';
        return { 
            otp, 
            sessionId, 
            expiryTime, 
            contactType,
            message: `OTP sent to ${contactLabel}. Valid for 10 minutes.`
        };
    }

    /**
     * Verifies OTP for any contact type with comprehensive validation
     * - SessionId prevents OTP reuse across sessions
     * - ExpiryTime prevents old OTP usage
     * - AttemptCount limits brute force attempts
     * - IsExpired allows manual invalidation
     */
    async verifyOTP(sessionId: string, contact: string, otp: string, purpose?: OTPPurpose): Promise<{ 
        success: boolean, 
        message: string,
        contactType?: OTPType
    }> {
        // 1. Find OTP record by sessionId
        const otpBySession = await this.repo.findOne({
            where: { SessionId: sessionId }
        });

        if (!otpBySession) {
            return { 
                success: false, 
                message: "Invalid session. OTP request not found." 
            };
        }

        // 2. Verify contact matches
        if (otpBySession.Contact !== contact) {
            return { 
                success: false, 
                message: "Invalid contact details for this verification session." 
            };
        }

        // 3. Verify purpose matches if provided
        if (purpose && otpBySession.Purpose !== purpose) {
            return { 
                success: false, 
                message: "The requested OTP purpose does not match this session." 
            };
        }

        // 4. Verify OTP is not already expired/used
        if (otpBySession.IsExpired) {
            return { 
                success: false, 
                message: "This OTP has already been used or invalidated. Please request a new one." 
            };
        }

        const userOTP = otpBySession;

        // Check if OTP has expired - prevents old OTP usage
        if (new Date() > userOTP.ExpiryTime) {
            userOTP.IsExpired = true; // Manual invalidation
            await this.repo.save(userOTP);
            return { 
                success: false, 
                message: "OTP has expired. Please request a new one." 
            };
        }

        // Check attempt count - limits brute force attempts
        if (userOTP.AttemptCount >= 5) {
            userOTP.IsExpired = true; // Manual invalidation after max attempts
            await this.repo.save(userOTP);
            return { 
                success: false, 
                message: "Maximum verification attempts exceeded. Please request a new OTP." 
            };
        }

        // Verify OTP matches
        if (userOTP.OTP !== otp) {
            userOTP.AttemptCount += 1;
            await this.repo.save(userOTP);
            const remainingAttempts = 5 - userOTP.AttemptCount;
            return { 
                success: false, 
                message: `Invalid OTP. ${remainingAttempts} attempts remaining.` 
            };
        }

        // OTP is valid - mark as expired to prevent reuse
        userOTP.IsExpired = true;
        userOTP.UpdatedDate = new Date();
        await this.repo.save(userOTP);

        return { 
            success: true, 
            message: "OTP verified successfully.",
            contactType: userOTP.OTPType as OTPType
        };
    }

    /**
     * Marks OTP as expired (manual invalidation)
     */
    async markAsExpired(sessionId: string): Promise<void> {
        await this.repo.update({ SessionId: sessionId }, { IsExpired: true, UpdatedDate: new Date() });
    }

    /**
     * Finds the latest unexpired OTP for a contact
     */
    async findLatestByContact(contact: string): Promise<UserOTP | null> {
        return await this.repo.findOne({
            where: { Contact: contact, IsExpired: false },
            order: { CreatedDate: "DESC" }
        });
    }

    /**
     * Counts how many OTPs were sent to a contact in the last 24 hours for a specific purpose.
     */
    async countDailyAttempts(contact: string, purpose: OTPPurpose): Promise<number> {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        return await this.repo.createQueryBuilder('u')
            .where('u.Contact = :contact', { contact })
            .andWhere('u.Purpose = :purpose', { purpose })
            .andWhere('u.CreatedDate >= :date', { date: twentyFourHoursAgo })
            .getCount();
    }

    /**
     * Cleans up expired OTPs (can be called periodically)
     */
    async cleanupExpiredOTPs(): Promise<void> {
        await this.repo.delete({
            IsExpired: true,
            ExpiryTime: new Date()
        });
    }
}

export const userOTPRepository = new UserOTPRepository();
