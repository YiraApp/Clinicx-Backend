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

    async getDoctorAppointments(doctorId: string, date: string): Promise<Appointment[]> {
        return await this.repo.createQueryBuilder("appointment")
            .leftJoinAndSelect("appointment.User", "user")
            .leftJoinAndSelect("appointment.Doctor", "doctor")
            .leftJoinAndSelect("appointment.Hospital", "hospital")
            .leftJoinAndSelect("appointment.Verifications", "verifications")
            .where("appointment.DoctorId = :doctorId", { doctorId })
            .andWhere("CAST(appointment.AppointmentDate AS DATE) = :date", { date })
            .orderBy("appointment.StartTime", "ASC")
            .getMany();
    }

    async getPatientAppointments(userId: string): Promise<Appointment[]> {
        return await this.repo.find({
            where: { UserId: userId },
            relations: ["Doctor", "Hospital"],
            order: { AppointmentDate: "DESC", StartTime: "DESC" }
        });
    }

    async getHospitalAppointments(hospitalId: number, date: string): Promise<Appointment[]> {
        return await this.repo.createQueryBuilder("appointment")
            .leftJoinAndSelect("appointment.User", "user")
            .leftJoinAndSelect("appointment.Doctor", "doctor")
            .where("appointment.HospitalId = :hospitalId", { hospitalId })
            .andWhere("CAST(appointment.AppointmentDate AS DATE) = :date", { date })
            .orderBy("appointment.StartTime", "ASC")
            .getMany();
    }

    async getAppointments(filters: { orgId?: number, hospitalId?: number, userId?: string, date?: string, status?: string }): Promise<Appointment[]> {
        const queryBuilder = this.repo.createQueryBuilder("appointment")
            .leftJoinAndSelect("appointment.User", "user")
            .leftJoinAndSelect("appointment.Doctor", "doctor")
            .leftJoinAndSelect("appointment.Hospital", "hospital")
            .leftJoinAndSelect("appointment.Verifications", "verifications");

        if (filters.orgId) {
            queryBuilder.andWhere("appointment.OrgId = :orgId", { orgId: filters.orgId });
        }
        if (filters.hospitalId) {
            queryBuilder.andWhere("appointment.HospitalId = :hospitalId", { hospitalId: filters.hospitalId });
        }
        if (filters.userId) {
            queryBuilder.andWhere("appointment.UserId = :userId", { userId: filters.userId });
        }
        if (filters.date) {
            // Use CAST to ensure we compare only the date part in MSSQL
            queryBuilder.andWhere("CAST(appointment.AppointmentDate AS DATE) = :date", { date: filters.date });
        }
        if (filters.status) {
            queryBuilder.andWhere("appointment.Status = :status", { status: filters.status });
        }

        return await queryBuilder
            .orderBy("appointment.AppointmentDate", "DESC")
            .addOrderBy("appointment.StartTime", "ASC")
            .getMany();
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
