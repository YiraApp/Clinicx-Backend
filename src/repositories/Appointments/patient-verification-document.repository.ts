import { AppDataSource } from "../../config/database.js";
import { PatientVerificationDocument } from "../../models/Appointments/patient-verification-document.model.js";

export class PatientVerificationDocumentRepository {
    private repo = AppDataSource.getRepository(PatientVerificationDocument);

    async findByAppointmentId(appointmentId: number): Promise<PatientVerificationDocument[]> {
        return await this.repo.find({
            where: { AppointmentId: appointmentId },
            order: { UploadedAt: "DESC" }
        });
    }

    async findByType(appointmentId: number, type: string): Promise<PatientVerificationDocument | null> {
        return await this.repo.findOne({
            where: { AppointmentId: appointmentId, DocumentType: type },
            order: { UploadedAt: "DESC" }
        });
    }

    async save(data: Partial<PatientVerificationDocument>): Promise<PatientVerificationDocument> {
        const doc = this.repo.create(data);
        return await this.repo.save(doc);
    }

    async upsert(appointmentId: number, type: string, data: Partial<PatientVerificationDocument>): Promise<PatientVerificationDocument> {
        const existing = await this.findByType(appointmentId, type);
        if (existing) {
            await this.repo.update(existing.Id, { ...data, UpdatedAt: new Date() });
            return (await this.findByType(appointmentId, type))!;
        } else {
            const newItem = this.repo.create({ ...data, AppointmentId: appointmentId, DocumentType: type });
            return await this.repo.save(newItem);
        }
    }
}

export const patientVerificationDocumentRepository = new PatientVerificationDocumentRepository();
