import dotenv from "dotenv";
dotenv.config();
import { initializeDatabase, AppDataSource } from "../src/config/database.js";
import { mobileAuthService } from "../src/MobileApi/v1/services/mobile-auth.service.js";
import { UserOTP } from "../src/models/Account/userotp.model.js";

async function testFullSignupFlow() {
  await initializeDatabase();
  const testPhone = "9998887772";
  console.log("1. Sending Signup OTP for", testPhone);
  const otpRes = await mobileAuthService.sendSignupOTP(testPhone, "91");
  console.log("OTP Sent:", otpRes);

  // Retrieve the generated OTP from DB for testing
  const otpEntry = await AppDataSource.getRepository(UserOTP).findOne({
    where: { SessionId: otpRes.sessionId }
  });
  console.log("OTP Code from DB:", otpEntry?.OTP);

  if (!otpEntry?.OTP) throw new Error("OTP not found in DB");

  console.log("2. Registering mobile patient...");
  const registerRes = await mobileAuthService.registerMobilePatient({
    phoneNumber: testPhone,
    countryCode: "91",
    firstName: "Aarav",
    lastName: "Sharma",
    email: "aarav.sharma@example.com",
    password: "StrongPass@2026",
    otp: otpEntry.OTP,
    sessionId: otpRes.sessionId
  });

  console.log("3. Registration SUCCESS!");
  console.log("Result:", {
    userId: registerRes.userId,
    firstName: registerRes.firstName,
    lastName: registerRes.lastName,
    email: registerRes.email,
    phoneNumber: registerRes.phoneNumber,
    latestUserRole: registerRes.latestUserRole,
    latestOrgId: registerRes.latestOrgId,
    latestHospitalId: registerRes.latestHospitalId,
    navigationId: registerRes.navigationId,
    hasToken: !!registerRes.token
  });

  process.exit(0);
}

testFullSignupFlow().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
