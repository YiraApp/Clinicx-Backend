import { AppDataSource } from "../src/config/database.js";
import { User } from "../src/models/Account/user.model.js";
import { Appointment } from "../src/models/Appointments/appointment.model.js";

async function run() {
    await AppDataSource.initialize();
    console.log("Database initialized successfully.");

    const users = await AppDataSource.getRepository(User).createQueryBuilder("u")
        .where("u.IsDeleted = 0")
        .andWhere("u.FirstName LIKE '%Srinivas%' OR u.FirstName LIKE '%Teja%' OR u.LastName LIKE '%Srinivas%' OR u.LastName LIKE '%Teja%'")
        .getMany();

    console.log("Found users matching Srinivas/Teja:\n", JSON.stringify(users.map(u => ({
        id: u.Id,
        firstName: u.FirstName,
        lastName: u.LastName,
        phone: u.PhoneNumber,
        isPrimary: u.IsPrimary,
        parentUserId: u.ParentUserId,
        relation: u.Relation
    })), null, 2));

    const appts = await AppDataSource.getRepository(Appointment).createQueryBuilder("a")
        .leftJoinAndSelect("a.User", "u")
        .orderBy("a.Id", "DESC")
        .take(10)
        .getMany();

    console.log("Recent 10 appointments in DB:\n", JSON.stringify(appts.map(a => ({
        id: a.Id,
        userId: a.UserId,
        userName: `${a.User?.FirstName || ''} ${a.User?.LastName || ''}`.trim(),
        userPhone: a.User?.PhoneNumber,
        userRelation: a.User?.Relation,
        isPrimary: a.User?.IsPrimary,
        parentUserId: a.User?.ParentUserId,
        appointmentDate: a.AppointmentDate,
        startTime: a.StartTime,
        status: a.Status,
        doctorId: a.DoctorId
    })), null, 2));

    await AppDataSource.destroy();
}

run().catch(console.error);
