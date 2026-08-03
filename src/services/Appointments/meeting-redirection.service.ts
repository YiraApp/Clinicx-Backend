import { v4 as uuidv4 } from "uuid";
import { meetingRedirectionRepository } from "../../repositories/Appointments/meeting-redirection.repository.js";
import { MeetingRedirection } from "../../models/Appointments/meeting-redirection.model.js";

export class MeetingRedirectionService {
    async createRedirection(data: {
        AppointmentId: number;
        PatientId: string;
        DoctorId: string;
        HospitalId: number;
        OrganizationId: number;
        MeetingUrl: string;
        AppointmentDate: Date | string;
        StartTime?: string;
    }): Promise<MeetingRedirection> {
        const urlId = uuidv4();
        const dateObj = typeof data.AppointmentDate === 'string' ? new Date(data.AppointmentDate) : data.AppointmentDate;
        
        return await meetingRedirectionRepository.create({
            UrlId: urlId,
            AppointmentId: data.AppointmentId,
            PatientId: data.PatientId,
            DoctorId: data.DoctorId,
            HospitalId: data.HospitalId,
            OrganizationId: data.OrganizationId,
            MeetingUrl: data.MeetingUrl,
            AppointmentDate: dateObj,
            StartTime: data.StartTime,
            IsActive: true
        });
    }

    async getOrCreateRedirection(data: {
        AppointmentId: number;
        PatientId: string;
        DoctorId: string;
        HospitalId: number;
        OrganizationId: number;
        MeetingUrl: string;
        AppointmentDate: Date | string;
        StartTime?: string;
    }): Promise<MeetingRedirection> {
        const existing = await meetingRedirectionRepository.findByAppointmentId(data.AppointmentId);
        if (existing) {
            if (data.MeetingUrl && existing.MeetingUrl !== data.MeetingUrl) {
                await meetingRedirectionRepository.update(existing.Id, { MeetingUrl: data.MeetingUrl });
                existing.MeetingUrl = data.MeetingUrl;
            }
            return existing;
        }
        return await this.createRedirection(data);
    }

    async getRedirectionDetails(urlId: string): Promise<MeetingRedirection | null> {
        const redirection = await meetingRedirectionRepository.findByUrlId(urlId);
        if (!redirection) {
            return null;
        }

        // Check expiry (valid until the end of the appointment day)
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const appointmentDate = new Date(redirection.AppointmentDate);
        appointmentDate.setHours(0, 0, 0, 0);

        if (today > appointmentDate) {
            // Expired! Mark as inactive in DB
            await meetingRedirectionRepository.update(redirection.Id, { IsActive: false });
            return null;
        }

        // Increment access count
        await meetingRedirectionRepository.incrementAccessCount(redirection.Id);

        return redirection;
    }
}

export const meetingRedirectionService = new MeetingRedirectionService();
