import { masterRepository } from "../../repositories/Masters/master.repository.js";

export class MasterService {
    async getAllSpecialties() {
        return await masterRepository.getAllSpecialties();
    }

    async getAllSubSpecialties(specialtyId?: number) {
        return await masterRepository.getAllSubSpecialties(specialtyId);
    }

    async getAllDepartments() {
        return await masterRepository.getAllDepartments();
    }
}

export const masterService = new MasterService();
