import { Request, Response } from "express";
import { meetingRedirectionService } from "../../services/Appointments/meeting-redirection.service.js";
import { appointmentRepository } from "../../repositories/Appointments/appointment.repository.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class MeetingRedirectionController {
    async getRedirection(req: Request, res: Response) {
        try {
            const urlId = req.params.urlId as string;
            if (!urlId) {
                return res.status(400).json(ApiResponse.error("URL ID is required."));
            }

            const redirection = await meetingRedirectionService.getRedirectionDetails(urlId);
            if (!redirection) {
                return res.status(404).json(ApiResponse.error("Meeting link not found or has expired."));
            }

            // Fetch complete appointment details for rich display in UI
            const appointment = await appointmentRepository.findById(redirection.AppointmentId);

            return res.json(ApiResponse.success({
                redirection,
                appointment: appointment ? {
                    PatientName: `${appointment.User?.FirstName || ""} ${appointment.User?.LastName || ""}`.trim(),
                    DoctorName: `${appointment.Doctor?.FirstName || ""} ${appointment.Doctor?.LastName || ""}`.trim(),
                    HospitalName: appointment.Hospital?.Name,
                    OrganizationName: appointment.Organization?.Name,
                    AppointmentDate: appointment.AppointmentDate,
                    StartTime: appointment.StartTime,
                    EndTime: appointment.EndTime
                } : null
            }));
        } catch (error: any) {
            console.error("[MeetingRedirectionController] Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const meetingRedirectionController = new MeetingRedirectionController();
