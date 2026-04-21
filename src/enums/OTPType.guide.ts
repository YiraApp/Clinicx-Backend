/**
 * OTP System Enums Usage Guide
 * 
 * This file demonstrates how to use the OTP enums throughout the application
 */

import { OTPType, OTPPurpose } from "./OTPType.enum.js";

// Mock for guide visibility
const userService = {
    sendOTP: async (contact: string, purpose: OTPPurpose) => ({}),
    verifyOTP: async (contact: string, sessionId: string, otp: string, purpose: OTPPurpose) => ({})
};

// ============================================
// ENUM DEFINITIONS
// ============================================

/**
 * OTPType Enum - Contact delivery method
 * Values: EMAIL, MOBILE
 * Auto-detected based on contact format
 */
export const OTPTypeGuide = {
    EMAIL: OTPType.EMAIL,      // For email contacts
    MOBILE: OTPType.MOBILE     // For phone number contacts
};

/**
 * OTPPurpose Enum - Distinguishes OTP use cases
 * Prevents cross-purpose attacks (e.g., LOGIN OTP can't verify email)
 */
export const OTPPurposeGuide = {
    VERIFICATION: OTPPurpose.VERIFICATION,              // Email/Mobile verification during signup
    LOGIN: OTPPurpose.LOGIN,                            // Two-factor authentication during login
    PASSWORD_RESET: OTPPurpose.PASSWORD_RESET,          // Password reset flow
    PHONE_CHANGE: OTPPurpose.PHONE_CHANGE,              // Changing registered phone number
    EMAIL_CHANGE: OTPPurpose.EMAIL_CHANGE,              // Changing registered email
    ACCOUNT_UNLOCK: OTPPurpose.ACCOUNT_UNLOCK,          // Unlock account after failed login attempts
    SENSITIVE_OPERATION: OTPPurpose.SENSITIVE_OPERATION // For critical operations
};

// ============================================
// USAGE EXAMPLES
// ============================================

/**
 * Example 1: Send OTP for Email Verification (Signup)
 */
export const example1SendEmailVerificationOTP = {
    endpoint: "POST /users/sendOTP",
    request: {
        contact: "user@example.com",
        purpose: OTPPurpose.VERIFICATION
    },
    response: {
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        contactType: OTPType.EMAIL,
        message: "OTP sent to email. Valid for 10 minutes."
    }
};

/**
 * Example 2: Send OTP for Mobile Verification (Signup)
 */
export const example2SendMobileVerificationOTP = {
    endpoint: "POST /users/sendOTP",
    request: {
        contact: "+919876543210",
        purpose: OTPPurpose.VERIFICATION
    },
    response: {
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        contactType: OTPType.MOBILE,
        message: "OTP sent to phone number. Valid for 10 minutes."
    }
};

/**
 * Example 3: Send OTP for Login (2FA)
 */
export const example3SendLoginOTP = {
    endpoint: "POST /users/sendOTP",
    request: {
        contact: "user@example.com",
        purpose: OTPPurpose.LOGIN
    },
    response: {
        sessionId: "660e8400-e29b-41d4-a716-446655440001",
        contactType: OTPType.EMAIL,
        message: "OTP sent to email. Valid for 10 minutes."
    }
};

/**
 * Example 4: Send OTP for Password Reset
 */
export const example4SendPasswordResetOTP = {
    endpoint: "POST /users/sendOTP",
    request: {
        contact: "user@example.com",
        purpose: OTPPurpose.PASSWORD_RESET
    },
    response: {
        sessionId: "770e8400-e29b-41d4-a716-446655440002",
        contactType: OTPType.EMAIL,
        message: "OTP sent to email. Valid for 10 minutes."
    }
};

/**
 * Example 5: Send OTP for Sensitive Operation (Payment, Security Settings)
 */
export const example5SendSensitiveOperationOTP = {
    endpoint: "POST /users/sendOTP",
    request: {
        contact: "user@example.com",
        purpose: OTPPurpose.SENSITIVE_OPERATION
    },
    response: {
        sessionId: "880e8400-e29b-41d4-a716-446655440003",
        contactType: OTPType.EMAIL,
        message: "OTP sent to email. Valid for 10 minutes."
    }
};

/**
 * Example 6: Verify OTP for Email Verification
 * IMPORTANT: purpose must match the sendOTP purpose
 */
export const example6VerifyEmailVerificationOTP = {
    endpoint: "POST /users/verifyOTP",
    request: {
        contact: "user@example.com",
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        otp: "123456",
        purpose: OTPPurpose.VERIFICATION  // Must match sendOTP purpose
    },
    response: {
        isVerified: true,
        verifiedField: "email",  // 'email' or 'mobile'
        message: "Email verified successfully."
    }
};

/**
 * Example 7: Verify OTP for Login (2FA)
 * This OTP can ONLY be used with LOGIN purpose, not VERIFICATION
 */
export const example7VerifyLoginOTP = {
    endpoint: "POST /users/verifyOTP",
    request: {
        contact: "user@example.com",
        sessionId: "660e8400-e29b-41d4-a716-446655440001",
        otp: "654321",
        purpose: OTPPurpose.LOGIN  // Must match sendOTP purpose
    },
    response: {
        isVerified: true,
        verifiedField: "email",
        message: "Email verified successfully."
    }
};

/**
 * Example 8: Verify OTP for Password Reset
 * This OTP can ONLY be used for password reset, prevents security holes
 */
export const example8VerifyPasswordResetOTP = {
    endpoint: "POST /users/verifyOTP",
    request: {
        contact: "user@example.com",
        sessionId: "770e8400-e29b-41d4-a716-446655440002",
        otp: "987654",
        purpose: OTPPurpose.PASSWORD_RESET  // Must match sendOTP purpose
    },
    response: {
        isVerified: true,
        verifiedField: "email",
        message: "Email verified successfully."
    }
};

// ============================================
// BACKEND USAGE IN CODE
// ============================================

/**
 * Example 9: Using Enums in Service Layer
 */
export class UserServiceExample {
    async sendPhoneVerificationOTP(phoneNumber: string): Promise<any> {
        // No need to pass OTPType - it's auto-detected
        // Just pass the contact and OTPPurpose enum
        return await userService.sendOTP(
            phoneNumber,
            OTPPurpose.VERIFICATION  // Using enum directly
        );
    }

    async sendLoginOTP(email: string): Promise<any> {
        return await userService.sendOTP(
            email,
            OTPPurpose.LOGIN  // Using enum directly
        );
    }

    async verifyLoginOTP(email: string, sessionId: string, otp: string): Promise<any> {
        return await userService.verifyOTP(
            email,
            sessionId,
            otp,
            OTPPurpose.LOGIN  // Must match sendOTP purpose
        );
    }
}

/**
 * Example 10: Using Enums in Controller Layer - Validation
 */
export class UserControllerExample {
    validatePurpose(purpose: string): purpose is OTPPurpose {
        return Object.values(OTPPurpose).includes(purpose as OTPPurpose);
    }

    async sendOTP(req: any, res: any): Promise<void> {
        const { contact, purpose } = req.body;

        // Validate purpose enum value
        if (purpose && !this.validatePurpose(purpose)) {
            return res.status(400).json({
                error: `Invalid purpose. Must be one of: ${Object.values(OTPPurpose).join(', ')}`
            });
        }

        const otpPurpose = purpose as OTPPurpose || OTPPurpose.VERIFICATION;
        // Send OTP with validated enum
    }
}

// ============================================
// SECURITY FEATURES WITH ENUMS
// ============================================

/**
 * Security Feature 1: Purpose Separation
 * 
 * Scenario: User requests PASSWORD_RESET OTP, but system processes it as LOGIN
 * Result WITHOUT purpose check: OTP can be used to login without reset permission
 * Result WITH purpose check (using enums): Verification fails - wrong purpose
 */
export const securityFeature1PurposeSeparation = {
    description: "OTPPurpose enum prevents cross-purpose OTP attacks",
    attack_scenario: "User gets PASSWORD_RESET OTP but tries to use it for LOGIN",
    prevention: "OTP.Purpose must match request purpose - enum enforces this"
};

/**
 * Security Feature 2: Contact Type Consistency
 * 
 * The OTPType enum auto-detected from contact format:
 * - EMAIL: user@example.com → OTPType.EMAIL
 * - MOBILE: +919876543210 → OTPType.MOBILE
 * 
 * This ensures consistent handling throughout the request lifecycle
 */
export const securityFeature2ContactTypeConsistency = {
    description: "OTPType enum ensures consistent contact handling",
    benefit: "No type confusion between email and mobile verification"
};

/**
 * Security Feature 3: Type Safety
 * 
 * Using TypeScript interfaces with actual OTPType/OTPPurpose values:
 * ✅ Compile-time checking: IDE shows available enum values
 * ✅ Runtime validation: Controller validates against enum values
 * ✅ Database consistency: Values match enum strings exactly
 */
export const securityFeature3TypeSafety = {
    benefit: "Compiler catches invalid OTPType/OTPPurpose values",
    example: "OTPPurpose.INVALID_VALUE // ❌ Compilation error"
};

// ============================================
// ENUM VALUE REFERENCE
// ============================================

export const enumReference = {
    OTPType: {
        values: Object.values(OTPType),
        description: "Determines delivery method"
    },
    OTPPurpose: {
        values: Object.values(OTPPurpose),
        description: "Determines OTP use case and validates purpose matching"
    }
};
