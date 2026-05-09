import { Request, Response } from "express";
import { patientQueueService } from "../../services/Appointments/patient-queue.service.js";
import { QueueStatus } from "../../enums/appointments.js";

export class PatientQueueController {
    async getHospitalQueue(req: Request, res: Response): Promise<void> {
        try {
            const hospitalId = parseInt(req.query.hospitalId as string);
            const date = req.query.date as string;

            if (isNaN(hospitalId)) {
                res.status(400).json({ status: "error", message: "HospitalId is required" });
                return;
            }

            const queue = await patientQueueService.getQueueByHospital(hospitalId, date);
            res.status(200).json({
                status: "success",
                data: queue
            });
        } catch (error: any) {
            console.error("[Patient Queue Controller] Error fetching hospital queue:", error.message);
            res.status(500).json({ status: "error", message: "Failed to fetch hospital queue" });
        }
    }

    async getQueue(req: Request, res: Response): Promise<void> {
        try {
            const doctorId = req.query.doctorId as string;
            const date = req.query.date as string;

            if (!doctorId) {
                res.status(400).json({ status: "error", message: "DoctorId is required" });
                return;
            }

            const queue = await patientQueueService.getQueueByDoctor(doctorId, date);
            res.status(200).json({
                status: "success",
                data: queue
            });
        } catch (error: any) {
            console.error("[Patient Queue Controller] Error fetching queue:", error.message);
            res.status(500).json({ status: "error", message: "Failed to fetch queue" });
        }
    }

    async updateStatus(req: Request, res: Response): Promise<void> {
        try {
            const queueId = parseInt(req.params.id as string);
            const { status } = req.body;

            if (isNaN(queueId) || !status) {
                res.status(400).json({ status: "error", message: "Valid QueueId and status are required" });
                return;
            }

            // Validate status
            if (!Object.values(QueueStatus).includes(status as QueueStatus)) {
                res.status(400).json({ status: "error", message: "Invalid status value" });
                return;
            }

            await patientQueueService.updateStatus(queueId, status as QueueStatus);
            res.status(200).json({
                status: "success",
                message: "Queue status updated successfully"
            });
        } catch (error: any) {
            console.error("[Patient Queue Controller] Error updating status:", error.message);
            res.status(500).json({ status: "error", message: "Failed to update queue status" });
        }
    }
}

export const patientQueueController = new PatientQueueController();
