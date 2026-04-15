/**
 * Enum for OTP contact types
 * Determines how OTP is delivered to the user
 */
export enum OTPType {
    EMAIL = 'EMAIL',
    MOBILE = 'MOBILE'
}

/**
 * Enum for OTP purposes
 * Distinguishes between different OTP use cases to prevent cross-purpose attacks
 * Example: A LOGIN OTP cannot be used for PASSWORD_RESET
 */
export enum OTPPurpose {
    VERIFICATION = 'VERIFICATION',          // Email/Mobile verification during signup
    LOGIN = 'LOGIN',                        // Two-factor authentication during login
    PASSWORD_RESET = 'PASSWORD_RESET',      // Password reset flow
    PHONE_CHANGE = 'PHONE_CHANGE',          // Changing registered phone number
    EMAIL_CHANGE = 'EMAIL_CHANGE',          // Changing registered email
    ACCOUNT_UNLOCK = 'ACCOUNT_UNLOCK',      // Unlock account after failed login attempts
    SENSITIVE_OPERATION = 'SENSITIVE_OPERATION' // For critical operations like payment/security changes
}
