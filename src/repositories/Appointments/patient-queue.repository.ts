import { AppDataSource } from "../../config/database.js";
import { PatientQueue } from "../../models/Appointments/patient-queue.model.js";

export class PatientQueueRepository {
    private repo = AppDataSource.getRepository(PatientQueue);

    async create(data: Partial<PatientQueue>): Promise<PatientQueue> {
        const queue = this.repo.create(data);
        return await this.repo.save(queue);
    }

    async findByAppointmentId(appointmentId: number): Promise<PatientQueue | null> {
        return await this.repo.findOne({ where: { AppointmentId: appointmentId } });
    }

    async findByIdWithAppointment(id: number): Promise<PatientQueue | null> {
        return await this.repo.findOne({
            where: { Id: id } as any,
            relations: ["Appointment"]
        });
    }

    async getNextQueueNumber(hospitalId: number, date: Date): Promise<number> {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        const result = await this.repo.createQueryBuilder("queue")
            .leftJoin("queue.Appointment", "appointment")
            .select("MAX(queue.QueueNumber)", "max")
            .where("appointment.HospitalId = :hospitalId", { hospitalId })
            .andWhere("queue.AddedAt BETWEEN :start AND :end", { start: startOfDay, end: endOfDay })
            .getRawOne();
        
        return (parseInt(result?.max) || 0) + 1;
    }

    async getQueueByHospital(hospitalId: number, date: Date): Promise<PatientQueue[]> {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        return await this.repo.createQueryBuilder("queue")
            .leftJoinAndSelect("queue.Appointment", "appointment")
            .leftJoinAndSelect("appointment.User", "user")
            .leftJoinAndSelect("queue.Doctor", "doctor")
            .where("appointment.HospitalId = :hospitalId", { hospitalId })
            .andWhere("queue.AddedAt BETWEEN :start AND :end", { start: startOfDay, end: endOfDay })
            .orderBy("queue.QueueNumber", "ASC")
            .getMany();
    }

    async getQueueByDoctor(doctorId: string, date: Date): Promise<PatientQueue[]> {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        return await this.repo.createQueryBuilder("queue")
            .leftJoinAndSelect("queue.Appointment", "appointment")
            .leftJoinAndSelect("appointment.User", "user")
            .where("queue.DoctorId = :doctorId", { doctorId })
            .andWhere("queue.AddedAt BETWEEN :start AND :end", { start: startOfDay, end: endOfDay })
            .orderBy("queue.QueueNumber", "ASC")
            .getMany();
    }

    async updateStatus(id: number, status: string): Promise<void> {
        const updateData: any = { Status: status };
        if (status === "Called") updateData.CalledAt = new Date();
        if (status === "Completed") updateData.CompletedAt = new Date();
        await this.repo.update(id, updateData);
    }
}

export const patientQueueRepository = new PatientQueueRepository();
