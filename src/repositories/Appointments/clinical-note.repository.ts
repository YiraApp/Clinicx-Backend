import { AppDataSource } from "../../config/database.js";
import { ClinicalNote } from "../../models/Appointments/clinical-note.model.js";

export class ClinicalNoteRepository {
    private repo = AppDataSource.getRepository(ClinicalNote);

    async create(data: Partial<ClinicalNote>): Promise<ClinicalNote> {
        const note = this.repo.create(data);
        return await this.repo.save(note);
    }

    async findByPatient(patientId: string, orgId?: number, hospitalId?: number, appointmentId?: number): Promise<ClinicalNote[]> {
        const where: any = { PatientId: patientId };
        if (orgId) where.OrganizationId = orgId;
        if (hospitalId) where.HospitalId = hospitalId;
        if (appointmentId) where.AppointmentId = appointmentId;

        console.log("ClinicalNoteRepository.findByPatient - Filter:", where);

        const notes = await this.repo.find({
            where,
            relations: ["Doctor", "Appointment"],
            order: { CreatedAt: "DESC" }
        });

        console.log(`ClinicalNoteRepository.findByPatient - Found ${notes.length} notes`);
        return notes;
    }

    async findByAppointment(appointmentId: number): Promise<ClinicalNote[]> {
        return await this.repo.find({
            where: { AppointmentId: appointmentId },
            relations: ["Doctor"],
            order: { CreatedAt: "DESC" }
        });
    }

    async findById(id: number): Promise<ClinicalNote | null> {
        return await this.repo.findOne({
            where: { Id: id },
            relations: ["Doctor", "Patient", "Appointment"]
        });
    }

    async update(id: number, data: Partial<ClinicalNote>): Promise<void> {
        await this.repo.update(id, { ...data, UpdatedAt: new Date() });
    }

    async delete(id: number): Promise<void> {
        await this.repo.delete(id);
    }
}

export const clinicalNoteRepository = new ClinicalNoteRepository();
