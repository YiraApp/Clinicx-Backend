import { AppDataSource } from '../src/config/database.js';
import { User } from '../src/models/Account/user.model.js';
import { PatientRegistration } from '../src/models/Organizations/patient-registration.model.js';

async function fixToken30() {
    try {
        await AppDataSource.initialize();
        const userRepo = AppDataSource.getRepository(User);
        const regRepo = AppDataSource.getRepository(PatientRegistration);

        const user = await userRepo.findOne({
            where: { Id: 'BCB83EFE-48FB-4A78-8BAE-C56AF5B3EF1E' }
        });

        if (!user) {
            console.error('User not found!');
            process.exit(1);
        }

        console.log('Current user token:', user.TokenNumber);
        user.TokenNumber = 'HOSP11-2026-0030';
        await userRepo.save(user);
        console.log('Updated user token to:', user.TokenNumber);

        const reg = await regRepo.findOne({
            where: { UserId: 'BCB83EFE-48FB-4A78-8BAE-C56AF5B3EF1E' }
        });

        if (reg) {
            console.log('Current reg token:', reg.TokenNumber);
            reg.TokenNumber = 'HOSP11-2026-0030';
            await regRepo.save(reg);
            console.log('Updated reg token to:', reg.TokenNumber);
        }

        console.log('Fix completed successfully!');
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

fixToken30();
