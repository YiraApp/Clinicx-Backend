import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;
const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY;
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY;
const JWT_ISSUER = process.env.JWT_ISSUER;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE;

if (!JWT_SECRET || !REFRESH_TOKEN_SECRET || !ACCESS_TOKEN_EXPIRY || !REFRESH_TOKEN_EXPIRY || !JWT_ISSUER || !JWT_AUDIENCE) {
    throw new Error("JWT configuration missing in .env file");
}

/**
 * Payload interface for JWT tokens.
 */
export interface TokenPayload {
    userId: string;
    email?: string | undefined;
    [key: string]: any;
}

/**
 * Generates an Access Token.
 * @param payload - The data to include in the token.
 * @returns The signed JWT token.
 */
export const generateAccessToken = (payload: TokenPayload): string => {
    return jwt.sign(payload, JWT_SECRET, {
        expiresIn: ACCESS_TOKEN_EXPIRY as any,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE
    });
};

/**
 * Generates a Refresh Token.
 * @param payload - The data to include in the token.
 * @returns The signed JWT token.
 */
export const generateRefreshToken = (payload: TokenPayload): string => {
    return jwt.sign(payload, REFRESH_TOKEN_SECRET, {
        expiresIn: REFRESH_TOKEN_EXPIRY as any,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE
    });
};

/**
 * Verifies an Access Token.
 * @param token - The token to verify.
 * @returns The decoded payload or null if invalid.
 */
export const verifyAccessToken = (token: string): TokenPayload | null => {
    try {
        return jwt.verify(token, JWT_SECRET, {
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE
        }) as TokenPayload;
    } catch (error) {
        return null;
    }
};

/**
 * Verifies a Refresh Token.
 * @param token - The token to verify.
 * @returns The decoded payload or null if invalid.
 */
export const verifyRefreshToken = (token: string): TokenPayload | null => {
    try {
        return jwt.verify(token, REFRESH_TOKEN_SECRET, {
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE
        }) as TokenPayload;
    } catch (error) {
        return null;
    }
};
