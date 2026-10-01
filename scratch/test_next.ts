import { AppDataSource } from '../src/config/database.js';
import { patientRegistrationService } from '../src/services/Organizations/patient-registration.service.js';

async function testNext() {
    await AppDataSource.initialize();
    const nextToken = await patientRegistrationService.getNextTokenNumber(19);
    console.log('Next Token will be:', nextToken);
    process.exit(0);
}

testNext();
