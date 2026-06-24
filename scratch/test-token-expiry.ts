import dotenv from 'dotenv';
dotenv.config();

import jwt from 'jsonwebtoken';

async function test() {
    console.log("Starting Token Expiry Test...");

    const { generateAccessToken, generateRefreshToken, verifyAccessToken } = await import('../src/utils/jwt.utils.js');

    const payload = { userId: "test-user-id", email: "test@example.com" };

    // Test 1: Standard expiration
    console.log("\n--- Test 1: Default expiration (from env) ---");
    console.log("ACCESS_TOKEN_EXPIRY in env:", process.env.ACCESS_TOKEN_EXPIRY);
    const defaultToken = generateAccessToken(payload);
    console.log("Default Token generated.");
    const decodedDefault = jwt.decode(defaultToken) as any;
    console.log("Decoded default token payload:", decodedDefault);
    if (decodedDefault && decodedDefault.exp) {
        const expDate = new Date(decodedDefault.exp * 1000);
        console.log("Expires at:", expDate.toISOString());
    }

    // Test 2: Custom expiration (30 days)
    console.log("\n--- Test 2: Mobile 30 days expiration ---");
    const mobileToken = generateAccessToken(payload, "30d");
    console.log("Mobile Token generated.");
    const decodedMobile = jwt.decode(mobileToken) as any;
    console.log("Decoded mobile token payload:", decodedMobile);
    if (decodedMobile && decodedMobile.exp) {
        const expDate = new Date(decodedMobile.exp * 1000);
        console.log("Expires at:", expDate.toISOString());
        
        // Calculate difference in days
        const diffMs = expDate.getTime() - Date.now();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        console.log("Lifetime in days:", diffDays.toFixed(2));
    }

    // Test 3: Verify access token
    console.log("\n--- Test 3: Verification ---");
    const verified = verifyAccessToken(mobileToken);
    console.log("Verification result:", verified ? "SUCCESS" : "FAILED");
}

test().catch(console.error);
