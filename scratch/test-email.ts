
import 'dotenv/config';
import { mailService } from '../src/services/Mail/mail.service.ts';

async function runTest() {
    console.log("Starting SMTP Test...");
    const testRecipient = "neelimanikanta02@gmail.com";
    
    try {
        await mailService.sendTestEmail(testRecipient);
        console.log("SUCCESS: Test email triggered.");
    } catch (error) {
        console.error("FAILURE: Test email failed.");
        console.error(error);
    }
}

runTest();
