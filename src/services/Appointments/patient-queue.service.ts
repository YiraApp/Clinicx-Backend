import { patientQueueRepository } from "../../repositories/Appointments/patient-queue.repository.js";
import { PatientQueue } from "../../models/Appointments/patient-queue.model.js";
import { AppDataSource } from "../../config/database.js";
import { Appointment } from "../../models/Appointments/appointment.model.js";

import { QueueStatus } from "../../enums/appointments.js";

export class PatientQueueService {
    async getQueueByHospital(hospitalId: number, date: string): Promise<PatientQueue[]> {
        const queryDate = date ? new Date(date) : new Date();
        return await patientQueueRepository.getQueueByHospital(hospitalId, queryDate);
    }

    async getQueueByDoctor(doctorId: string, date: string): Promise<PatientQueue[]> {
        const queryDate = date ? new Date(date) : new Date();
        return await patientQueueRepository.getQueueByDoctor(doctorId, queryDate);
    }

    async updateStatus(queueId: number, status: QueueStatus): Promise<void> {
        await patientQueueRepository.updateStatus(queueId, status);

        // Sync with Appointment status
        const queueEntry = await patientQueueRepository.findByIdWithAppointment(queueId);

        if (queueEntry?.AppointmentId) {
            const appointmentRepo = AppDataSource.getRepository(Appointment);
            if (status === QueueStatus.WithDoctor) {
                await appointmentRepo.update(queueEntry.AppointmentId, { Status: "InProgress" });
            } else if (status === QueueStatus.Completed) {
                await appointmentRepo.update(queueEntry.AppointmentId, { Status: "Completed" });
            }
        }
    }

    async addToQueue(appointmentId: number, doctorId: string, hospitalId: number): Promise<PatientQueue> {
        // Check if already in queue
        const existing = await patientQueueRepository.findByAppointmentId(appointmentId);
        if (existing) return existing;

        const nextNumber = await patientQueueRepository.getNextQueueNumber(hospitalId, new Date());
        return await patientQueueRepository.create({
            AppointmentId: appointmentId,
            DoctorId: doctorId,
            QueueNumber: nextNumber,
            Status: QueueStatus.Waiting,
            AddedAt: new Date()
        });
    }
}

export const patientQueueService = new PatientQueueService();
