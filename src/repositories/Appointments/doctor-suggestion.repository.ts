import { AppDataSource } from "../../config/database.js";
import { DoctorSuggestion } from "../../models/Appointments/doctor-suggestion.model.js";

export class DoctorSuggestionRepository {
    private repo = AppDataSource.getRepository(DoctorSuggestion);

    async create(data: Partial<DoctorSuggestion>): Promise<DoctorSuggestion> {
        const suggestion = this.repo.create(data);
        return await this.repo.save(suggestion);
    }

    async findByPatient(patientId: string, orgId?: number, hospitalId?: number): Promise<DoctorSuggestion[]> {
        return this.findByPatientIds([patientId], orgId, hospitalId);
    }

    async findByPatientIds(patientIds: string[], orgId?: number, hospitalId?: number): Promise<DoctorSuggestion[]> {
        const isGuid = (val?: string): boolean =>
            !!val && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(val.trim());

        const validIds = (patientIds || []).map(id => id.trim()).filter(isGuid);
        if (validIds.length === 0) return [];

        const qb = this.repo.createQueryBuilder("s")
            .leftJoinAndSelect("s.Doctor", "Doctor")
            .where("s.PatientId IN (:...patientIds)", { patientIds: validIds })
            .orderBy("s.CreatedAt", "DESC");

        if (orgId) {
            qb.andWhere("s.OrganizationId = :orgId", { orgId });
        }
        if (hospitalId) {
            qb.andWhere("s.HospitalId = :hospitalId", { hospitalId });
        }

        return await qb.getMany();
    }

    async findById(id: number): Promise<DoctorSuggestion | null> {
        return await this.repo.findOne({
            where: { Id: id },
            relations: ["Doctor", "Patient"]
        });
    }

    async delete(id: number): Promise<void> {
        await this.repo.delete(id);
    }
}

export const doctorSuggestionRepository = new DoctorSuggestionRepository();
