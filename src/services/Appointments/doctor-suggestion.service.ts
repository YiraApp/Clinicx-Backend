import { doctorSuggestionRepository } from "../../repositories/Appointments/doctor-suggestion.repository.js";
import { DoctorSuggestion } from "../../models/Appointments/doctor-suggestion.model.js";
import { AppDataSource } from "../../config/database.js";
import { User } from "../../models/Account/user.model.js";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";

export class DoctorSuggestionService {
    private async resolveCandidatePatientIds(patientId: string): Promise<string[]> {
        const set = new Set<string>();
        if (!patientId) return [];
        set.add(patientId);

        try {
            const userRepo = AppDataSource.getRepository(User);
            const regRepo = AppDataSource.getRepository(PatientRegistration);

            const numId = parseInt(patientId, 10);
            if (!isNaN(numId)) {
                const reg = await regRepo.findOne({ where: { Id: numId } }).catch(() => null);
                if (reg?.UserId) set.add(reg.UserId);
            }

            const user = await userRepo.createQueryBuilder("u")
                .where("u.Id = :id OR u.PhoneNumber = :phone OR u.Email = :email", {
                    id: patientId,
                    phone: patientId,
                    email: patientId
                })
                .getOne()
                .catch(() => null);

            if (user?.Id) set.add(user.Id);

            const regs = await regRepo.find({ where: { UserId: patientId } }).catch(() => []);
            for (const r of regs) {
                set.add(String(r.Id));
                if (r.UserId) set.add(r.UserId);
            }
        } catch (e) {
            console.error("[DoctorSuggestionService] Error resolving patient IDs:", e);
        }

        return Array.from(set);
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
