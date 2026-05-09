import { AppDataSource } from "../../config/database.js";
import { Appointment } from "../../models/Appointments/appointment.model.js";

export class AppointmentRepository {
    private repo = AppDataSource.getRepository(Appointment);

    async create(data: Partial<Appointment>): Promise<Appointment> {
        const appointment = this.repo.create(data);
        return await this.repo.save(appointment);
    }

    async findById(id: number): Promise<Appointment | null> {
        return await this.repo.findOne({
            where: { Id: id },
            relations: ["User", "Doctor", "Hospital", "Organization"]
        });
    }

    async getDoctorAppointments(doctorId: string, date: Date): Promise<Appointment[]> {
        return await this.repo.find({
            where: {
                DoctorId: doctorId,
                AppointmentDate: date
            },
            relations: ["User", "Doctor", "Hospital", "Verifications"],
            order: { StartTime: "ASC" }
        });
    }

    async getPatientAppointments(userId: string): Promise<Appointment[]> {
        return await this.repo.find({
            where: { UserId: userId },
            relations: ["Doctor", "Hospital"],
            order: { AppointmentDate: "DESC", StartTime: "DESC" }
        });
    }

    async getHospitalAppointments(hospitalId: number, date: Date): Promise<Appointment[]> {
        return await this.repo.find({
            where: {
                HospitalId: hospitalId,
                AppointmentDate: date
            },
            relations: ["User", "Doctor"],
            order: { StartTime: "ASC" }
        });
    }

    async getAppointments(filters: { orgId?: number, hospitalId?: number, userId?: string, date?: string, status?: string }): Promise<Appointment[]> {
        const query: any = {};
        if (filters.orgId) query.OrgId = filters.orgId;
        if (filters.hospitalId) query.HospitalId = filters.hospitalId;
        if (filters.userId) query.UserId = filters.userId;
        if (filters.date) query.AppointmentDate = new Date(filters.date);
        if (filters.status) query.Status = filters.status;

        return await this.repo.find({
            where: query,
            relations: ["User", "Doctor", "Hospital", "Verifications"],
            order: { AppointmentDate: "DESC", StartTime: "ASC" }
        });
    }

    async updateStatus(id: number, status: string): Promise<void> {
        await this.repo.update(id, { Status: status, UpdatedAt: new Date() });
    }

    async getNextAppointmentNumber(hospitalId: number, date: Date): Promise<number> {
        // Format date to YYYY-MM-DD
        const dateString = date.toISOString().split('T')[0];

        const result = await this.repo.createQueryBuilder("appointment")
            .select("MAX(appointment.AppointmentNumber)", "max")
            .where("appointment.HospitalId = :hospitalId", { hospitalId })
            .andWhere("CAST(appointment.AppointmentDate AS DATE) = :date", { date: dateString })
            .getRawOne();

        const nextNumber = (parseInt(result?.max) || 0) + 1;
        return nextNumber;
    }
}

export const appointmentRepository = new AppointmentRepository();
