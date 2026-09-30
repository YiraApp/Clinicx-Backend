import { AppDataSource } from '../src/config/database.js';
import { User } from '../src/models/Account/user.model.js';
import { PatientRegistration } from '../src/models/Organizations/patient-registration.model.js';

async function check() {
    try {
        await AppDataSource.initialize();
        const userRepo = AppDataSource.getRepository(User);
        const regRepo = AppDataSource.getRepository(PatientRegistration);

        const users = await userRepo.createQueryBuilder('u')
            .where("u.TokenNumber LIKE '%0029%' OR u.TokenNumber LIKE '%0030%' OR u.TokenNumber LIKE '%0031%'")
            .getMany();

        console.log('--- USERS ---');
        for (const u of users) {
            console.log(`ID: ${u.Id} | Name: ${u.FirstName} ${u.LastName} | Phone: ${u.PhoneNumber} | Token: ${u.TokenNumber}`);
        }

        const regs = await regRepo.createQueryBuilder('pr')
            .where("pr.TokenNumber LIKE '%0029%' OR pr.TokenNumber LIKE '%0030%' OR pr.TokenNumber LIKE '%0031%'")
            .getMany();

        console.log('--- PATIENT REGISTRATIONS ---');
        for (const r of regs) {
            console.log(`ID: ${r.Id} | UserId: ${r.UserId} | HospitalId: ${r.HospitalId} | Token: ${r.TokenNumber}`);
        }

        process.exit(0);
    } catch (e) {
        console.error('Error:', e);
        process.exit(1);
    }
}

check();
