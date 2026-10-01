import { AppDataSource } from '../src/config/database.js';
import { patientRegistrationService } from '../src/services/Organizations/patient-registration.service.js';

async function testConcurrency() {
    await AppDataSource.initialize();

    console.log("Simulating 10 simultaneous token generation requests...");
    const promises = Array.from({ length: 10 }).map((_, i) => 
        patientRegistrationService.getNextTokenNumber(19).then(res => ({
            reqIndex: i,
            tokenNumber: res.tokenNumber,
            nextSequence: res.nextSequence
        }))
    );

    const results = await Promise.all(promises);
    console.log("Results:");
    console.table(results);

    const tokens = results.map(r => r.tokenNumber);
    const uniqueTokens = new Set(tokens);
    console.log(`Total generated: ${tokens.length} | Unique: ${uniqueTokens.size}`);

    if (uniqueTokens.size < tokens.length) {
        console.error("❌ CONCURRENCY BUG DETECTED: Duplicate tokens generated!");
    } else {
        console.log("✅ ALL TOKENS UNIQUE AND SEQUENTIAL!");
    }

    process.exit(0);
}

testConcurrency();
