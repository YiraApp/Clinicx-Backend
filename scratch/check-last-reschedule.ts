import dotenv from "dotenv";
dotenv.config();

import { initializeDatabase, AppDataSource } from "../src/config/database.js";
import { Appointment } from "../src/models/Appointments/appointment.model.js";

async function checkRecentAppointments() {
    await initializeDatabase();
    console.log("Database initialized.\n");

    const recent = await AppDataSource.getRepository(Appointment).find({
        order: { UpdatedAt: "DESC", Id: "DESC" },
        take: 5,
        relations: ["User", "Doctor", "Hospital"]
    });

    console.log("5 Most Recent Appointments:");
    for (const a of recent) {
        console.log({
            Id: a.Id,
            UserId: a.UserId,
            PatientName: `${a.User?.FirstName || ''} ${a.User?.LastName || ''}`,
            PhoneNumber: a.User?.PhoneNumber,
            CountryCode: a.User?.CountryCode,
            DoctorName: `${a.Doctor?.FirstName || ''} ${a.Doctor?.LastName || ''}`,
            HospitalName: a.Hospital?.Name,
            AppointmentDate: a.AppointmentDate,
            StartTime: a.StartTime,
            UpdatedAt: a.UpdatedAt
        });
    }

    process.exit(0);
}

checkRecentAppointments().catch(console.error);
