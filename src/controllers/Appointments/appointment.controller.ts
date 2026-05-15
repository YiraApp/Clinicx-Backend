import { Request, Response } from "express";
import { appointmentService } from "../../services/Appointments/appointment.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class AppointmentController {
    async book(req: Request, res: Response) {
        try {
            const result = await appointmentService.bookAppointment(req.body);
            return res.status(201).json(ApiResponse.success(result, "Appointment booked successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async getAppointments(req: Request, res: Response) {
        try {
            const orgId = req.query.orgId ? parseInt(String(req.query.orgId)) : undefined;
            const hospitalId = req.query.hospitalId ? parseInt(String(req.query.hospitalId)) : undefined;
            const userId = req.query.userId ? String(req.query.userId) : undefined;
            const date = req.query.date ? String(req.query.date) : undefined;
            const status = req.query.status ? String(req.query.status) : undefined;

            const result = await appointmentService.getAppointments({ orgId, hospitalId, userId, date, status });
            return res.json(ApiResponse.success(result));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async getDoctorAppointments(req: Request, res: Response) {
        try {
            const doctorId = String(req.params.doctorId);
            const date = String(req.query.date);
            const result = await appointmentService.getDoctorAppointments(doctorId, date);
            return res.json(ApiResponse.success(result));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async getHospitalAppointments(req: Request, res: Response) {
        try {
            const hospitalId = parseInt(req.query.hospitalId as string);
            const date = String(req.query.date);
            if (!hospitalId || !req.query.date) {
                return res.status(400).json(ApiResponse.error("Hospital ID and Date are required."));
            }
            const result = await appointmentService.getHospitalAppointments(hospitalId, date);
            return res.json(ApiResponse.success(result));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async getPatientAppointments(req: Request, res: Response) {
        try {
            const userId = String(req.params.userId);
            const result = await appointmentService.getPatientAppointments(userId);
            return res.json(ApiResponse.success(result));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async updateStatus(req: Request, res: Response) {
        try {
            const id = String(req.params.id);
            const status = String(req.body.status);
            await appointmentService.updateAppointmentStatus(parseInt(id), status);
            return res.json(ApiResponse.success(null, "Appointment status updated successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async cancel(req: Request, res: Response) {
        try {
            const id = String(req.params.id);
            const { slotId } = req.body;
            await appointmentService.cancelAppointment(parseInt(id), slotId);
            return res.json(ApiResponse.success(null, "Appointment cancelled successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async createInstantMeeting(req: Request, res: Response) {
        try {
            const topic = req.body.topic || "Instant Consultation";
            const result = await appointmentService.createInstantMeeting(topic);
            return res.json(ApiResponse.success(result, "Instant meeting created successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }
}

export const appointmentController = new AppointmentController();
