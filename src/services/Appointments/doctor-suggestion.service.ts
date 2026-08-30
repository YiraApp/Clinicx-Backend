import { doctorSuggestionRepository } from "../../repositories/Appointments/doctor-suggestion.repository.js";
import { DoctorSuggestion } from "../../models/Appointments/doctor-suggestion.model.js";
import { AppDataSource } from "../../config/database.js";
import { User } from "../../models/Account/user.model.js";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";

export class DoctorSuggestionService {
    private async resolveCandidatePatientIds(patientId: string): Promise<string[]> {
        const set = new Set<string>();
        if (!patientId) return [];

        const isGuid = (val?: string): boolean =>
            !!val && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(val.trim());

        if (isGuid(patientId)) {
            set.add(patientId.trim());
        }

        try {
            const userRepo = AppDataSource.getRepository(User);
            const regRepo = AppDataSource.getRepository(PatientRegistration);

            const numId = parseInt(patientId, 10);
            if (!isNaN(numId) && String(numId) === patientId.trim()) {
                const reg = await regRepo.findOne({ where: { Id: numId } }).catch(() => null);
                if (reg?.UserId && isGuid(reg.UserId)) set.add(reg.UserId.trim());
            }

            const queryBuilder = userRepo.createQueryBuilder("u");
            if (isGuid(patientId)) {
                queryBuilder.where("u.Id = :id OR u.PhoneNumber = :phone OR u.Email = :email", {
                    id: patientId.trim(),
                    phone: patientId.trim(),
                    email: patientId.trim()
                });
            } else {
                queryBuilder.where("u.PhoneNumber = :phone OR u.Email = :email", {
                    phone: patientId.trim(),
                    email: patientId.trim()
                });
            }

            const user = await queryBuilder.getOne().catch(() => null);

            if (user?.Id && isGuid(user.Id)) set.add(user.Id.trim());

            const baseGuid = user?.Id || (isGuid(patientId) ? patientId.trim() : null);
            if (baseGuid) {
                const regs = await regRepo.find({ where: { UserId: baseGuid } }).catch(() => []);
                for (const r of regs) {
                    if (r.UserId && isGuid(r.UserId)) set.add(r.UserId.trim());
                }
            }
        } catch (e) {
            console.error("[DoctorSuggestionService] Error resolving patient IDs:", e);
        }

        return Array.from(set).filter(id => isGuid(id));
    }

    async addSuggestion(data: {
        doctorId: string;
        patientId: string;
        title: string;
        description: string;
        filePath?: string;
        fileName?: string;
        organizationId?: number;
        hospitalId?: number;
    }): Promise<DoctorSuggestion> {
        const candidateIds = await this.resolveCandidatePatientIds(data.patientId);
        const preferredPatientId = candidateIds.find(id => id.length > 20) || data.patientId;

        return await doctorSuggestionRepository.create({
            DoctorId: data.doctorId,
            PatientId: preferredPatientId,
            Title: data.title,
            Description: data.description,
            FilePath: data.filePath,
            FileName: data.fileName,
            OrganizationId: data.organizationId,
            HospitalId: data.hospitalId
        });
    }

    async getPatientSuggestions(patientId: string, orgId?: number, hospitalId?: number): Promise<DoctorSuggestion[]> {
        const candidateIds = await this.resolveCandidatePatientIds(patientId);
        return await doctorSuggestionRepository.findByPatientIds(candidateIds, orgId, hospitalId);
    }

    async deleteSuggestion(id: number): Promise<void> {
        await doctorSuggestionRepository.delete(id);
    }
}

export const doctorSuggestionService = new DoctorSuggestionService();
