import { AppDataSource } from '../src/config/database.js';
import { Appointment } from '../src/models/Appointments/appointment.model.js';

async function check() {
    try {
        await AppDataSource.initialize();
        const apptRepo = AppDataSource.getRepository(Appointment);
        const appts = await apptRepo.find({
            where: { UserId: 'BCB83EFE-48FB-4A78-8BAE-C56AF5B3EF1E' }
        });
        console.log('Appointments for Manikanta (31):', appts.length);
        for (const a of appts) {
            console.log('Appt:', a.Id, a.AppointmentDate, a.Status);
        }
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
check();
