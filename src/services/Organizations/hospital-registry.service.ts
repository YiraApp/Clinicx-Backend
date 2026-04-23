import { hospitalRegistryRepository } from "../../repositories/Organizations/hospital-registry.repository.js";

export class HospitalRegistryService {
    async getHospitalRegistry(hospitalId: number) {
        const specialties = await hospitalRegistryRepository.getHospitalSpecialties(hospitalId);
        const subSpecialties = await hospitalRegistryRepository.getHospitalSubSpecialties(hospitalId);
        const departments = await hospitalRegistryRepository.getHospitalDepartments(hospitalId);

        return { specialties, subSpecialties, departments };
    }

    async updateHospitalRegistry(hospitalId: number, data: {
        specialties: { mainId?: number, name: string }[],
        subSpecialties: { mainId?: number, name: string }[],
        departments: { mainId?: number, name: string }[]
    }) {
        // Simple strategy: we could clear and re-add or just add new ones.
        // For registration flow, bulk add is sufficient.
        
        const results = {
            specialties: await hospitalRegistryRepository.bulkAddSpecialties(hospitalId, data.specialties),
            subSpecialties: await hospitalRegistryRepository.bulkAddSubSpecialties(hospitalId, data.subSpecialties),
            departments: await hospitalRegistryRepository.bulkAddDepartments(hospitalId, data.departments)
        };

        return results;
    }
}

export const hospitalRegistryService = new HospitalRegistryService();
