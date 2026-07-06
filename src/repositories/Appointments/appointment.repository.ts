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

    async getDoctorAppointments(doctorId: string, date: string, orgId?: number, hospitalId?: number): Promise<Appointment[]> {
        const query = this.repo.createQueryBuilder("appointment")
            .leftJoinAndSelect("appointment.User", "user")
            .leftJoinAndSelect("appointment.Doctor", "doctor")
            .leftJoinAndSelect("appointment.Hospital", "hospital")
            .leftJoinAndSelect("appointment.Verifications", "verifications")
            .where("appointment.DoctorId = :doctorId", { doctorId })
            .andWhere("CAST(appointment.AppointmentDate AS DATE) = :date", { date });

        if (orgId !== undefined && !isNaN(orgId)) {
            query.andWhere("appointment.OrgId = :orgId", { orgId });
        }

        if (hospitalId !== undefined && !isNaN(hospitalId)) {
            query.andWhere("appointment.HospitalId = :hospitalId", { hospitalId });
        }

        return await query.orderBy("appointment.StartTime", "ASC")
            .getMany();
    }

    async getPatientAppointments(userId: string): Promise<Appointment[]> {
        return await this.repo.find({
            where: { UserId: userId },
            relations: ["Doctor", "Doctor.User", "Hospital"],
            order: { AppointmentDate: "DESC", StartTime: "DESC" }
        });
    }

    async getPatientHospitalSummary(userId: string): Promise<Array<{ hospitalId: number, hospitalName: string, appointmentCount: number }>> {
        const raw = await this.repo.createQueryBuilder("appointment")
            .leftJoin("appointment.Hospital", "hospital")
            .select("appointment.HospitalId", "hospitalId")
            .addSelect("MAX(hospital.Name)", "hospitalName")
            .addSelect("COUNT(appointment.Id)", "appointmentCount")
            .where("appointment.UserId = :userId", { userId })
            .groupBy("appointment.HospitalId")
            .getRawMany();

        return raw.map(r => ({
            hospitalId: Number(r.hospitalId),
            hospitalName: String(r.hospitalName || "Clinic"),
            appointmentCount: Number(r.appointmentCount || 0)
        }));
    }

    async getPatientAppointmentsByHospital(userId: string, hospitalId: number): Promise<Appointment[]> {
        return await this.repo.find({
            where: { UserId: userId, HospitalId: hospitalId },
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

    async getAppointments(filters: { orgId?: number, hospitalId?: number, userId?: string, doctorId?: string, date?: string, status?: string, startDate?: string, endDate?: string, page?: number, pageSize?: number }): Promise<{ data: Appointment[], total: number }> {
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
        if (filters.doctorId) {
            queryBuilder.andWhere("appointment.DoctorId = :doctorId", { doctorId: filters.doctorId });
        }
        if (filters.date) {
            queryBuilder.andWhere("CAST(appointment.AppointmentDate AS DATE) = :date", { date: filters.date });
        }
        if (filters.startDate) {
            queryBuilder.andWhere("CAST(appointment.AppointmentDate AS DATE) >= :startDate", { startDate: filters.startDate });
        }
        if (filters.endDate) {
            queryBuilder.andWhere("CAST(appointment.AppointmentDate AS DATE) <= :endDate", { endDate: filters.endDate });
        }
        if (filters.status) {
            queryBuilder.andWhere("appointment.Status = :status", { status: filters.status });
        }

        const total = await queryBuilder.getCount();

        const page = filters.page || 1;
        const pageSize = filters.pageSize || 50;
        const skip = (page - 1) * pageSize;

        const data = await queryBuilder
            .orderBy("appointment.AppointmentDate", "DESC")
            .addOrderBy("appointment.StartTime", "ASC")
            .skip(skip)
            .take(pageSize)
            .getMany();

        return { data, total };
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
