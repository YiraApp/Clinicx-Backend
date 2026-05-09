import { clinicalNoteRepository } from "../../repositories/Appointments/clinical-note.repository.js";
import { ClinicalNote } from "../../models/Appointments/clinical-note.model.js";

export class ClinicalNoteService {
    async addNote(data: {
        appointmentId?: number;
        doctorId?: string;
        patientId: string;
        notes: string;
        organizationId?: number;
        hospitalId?: number;
        createdBy?: string;
    }): Promise<ClinicalNote> {
        return await clinicalNoteRepository.create({
            AppointmentId: data.appointmentId,
            DoctorId: data.doctorId,
            PatientId: data.patientId,
            Notes: data.notes,
            OrganizationId: data.organizationId,
            HospitalId: data.hospitalId,
            CreatedBy: data.createdBy
        });
    }

    async getPatientNotes(patientId: string, orgId?: number, hospitalId?: number, appointmentId?: number): Promise<ClinicalNote[]> {
        return await clinicalNoteRepository.findByPatient(patientId, orgId, hospitalId, appointmentId);
    }

    async getAppointmentNotes(appointmentId: number): Promise<ClinicalNote[]> {
        return await clinicalNoteRepository.findByAppointment(appointmentId);
    }

    async updateNote(id: number, notes: string, updatedBy?: string): Promise<void> {
        await clinicalNoteRepository.update(id, {
            Notes: notes,
            UpdatedBy: updatedBy
        });
    }

    async deleteNote(id: number): Promise<void> {
        await clinicalNoteRepository.delete(id);
    }
}

export const clinicalNoteService = new ClinicalNoteService();
