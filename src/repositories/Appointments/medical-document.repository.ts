import { AppDataSource } from "../../config/database.js";
import { MedicalDocument } from "../../models/Appointments/medical-document.model.js";

export class MedicalDocumentRepository {
    private repo = AppDataSource.getRepository(MedicalDocument);

    async save(document: MedicalDocument): Promise<MedicalDocument> {
        return await this.repo.save(document);
    }

    async findByPatient(patientId: string, organizationId?: number, hospitalId?: number): Promise<MedicalDocument[]> {
        const query: any = { PatientId: patientId, IsDeleted: false };
        if (organizationId) query.OrganizationId = organizationId;
        if (hospitalId) query.HospitalId = hospitalId;

        return await this.repo.find({
            where: query,
            order: { CreatedAt: "DESC" }
        });
    }

    async findById(id: number): Promise<MedicalDocument | null> {
        return await this.repo.findOne({ where: { Id: id, IsDeleted: false } });
    }

    async softDelete(id: number, updatedBy?: string): Promise<void> {
        await this.repo.update(id, { IsDeleted: true, UpdatedBy: updatedBy, UpdatedAt: new Date() });
    }
}

export const medicalDocumentRepository = new MedicalDocumentRepository();
