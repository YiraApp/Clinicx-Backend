import { In, LessThan } from "typeorm/index.js";
import { AppDataSource } from "../../config/database.js";
import { MedicalDocument } from "../../models/Appointments/medical-document.model.js";

export class MedicalDocumentRepository {
    private repo = AppDataSource.getRepository(MedicalDocument);

    async save(document: MedicalDocument): Promise<MedicalDocument> {
        return await this.repo.save(document);
    }

    async findByPatient(patientId: string, organizationId?: number, hospitalId?: number, appointmentId?: number, limit?: number): Promise<MedicalDocument[]> {
        const query: any = { PatientId: patientId, IsDeleted: false };
        if (appointmentId) {
            query.AppointmentId = appointmentId;
        } else {
            if (organizationId) query.OrganizationId = organizationId;
            if (hospitalId) query.HospitalId = hospitalId;
        }

        const findOptions: any = {
            where: query,
            relations: ["UploadedByUser", "Hospital", "Organization", "Appointment", "Appointment.Hospital"],
            order: { CreatedAt: "DESC" }
        };
        if (limit && limit > 0) {
            findOptions.take = limit;
        }

        return await this.repo.find(findOptions);
    }

    async findById(id: number): Promise<MedicalDocument | null> {
        return await this.repo.findOne({ where: { Id: id, IsDeleted: false } });
    }

    async findByAppointment(appointmentId: number): Promise<MedicalDocument[]> {
        return await this.repo.find({
            where: { AppointmentId: appointmentId, IsDeleted: false },
            relations: ["UploadedByUser"],
            order: { CreatedAt: "DESC" }
        });
    }

    async saveAiAnalysis(id: number, analysisJson: string, status: string): Promise<void> {
        await this.repo.update(id, { AiAnalysis: analysisJson, AiStatus: status, AiAnalyzedAt: new Date() });
    }

    async startAiJob(id: number, jobId: string): Promise<void> {
        await this.repo.update(id, { AiJobStatus: "processing", AiJobId: jobId, AiJobStartedAt: new Date() });
    }

    async findByAiJobId(jobId: string): Promise<MedicalDocument | null> {
        return await this.repo.findOne({ where: { AiJobId: jobId, IsDeleted: false } });
    }

    async findStaleAiJobs(startedBefore: Date): Promise<MedicalDocument[]> {
        return await this.repo.find({
            where: { AiJobStatus: "processing", AiJobStartedAt: LessThan(startedBefore), IsDeleted: false },
            take: 20,
        });
    }

    /**
     * Moves a job from one of [from] to [to] only if it is still there, so two
     * servers (or a webhook and the timeout) can't both finish the same job.
     */
    async moveAiJob(id: number, from: string[], to: string): Promise<boolean> {
        const result = await this.repo.update({ Id: id, AiJobStatus: In(from) }, { AiJobStatus: to });
        return (result.affected ?? 0) > 0;
    }

    async softDelete(id: number, updatedBy?: string): Promise<void> {
        await this.repo.update(id, { IsDeleted: true, UpdatedBy: updatedBy, UpdatedAt: new Date() });
    }
}

export const medicalDocumentRepository = new MedicalDocumentRepository();
