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
        // Step 1: Soft-delete all current entries for this hospital.
        // This ensures any removed items are properly deactivated.
        await hospitalRegistryRepository.softDeleteAllSpecialties(hospitalId);
        await hospitalRegistryRepository.softDeleteAllSubSpecialties(hospitalId);
        await hospitalRegistryRepository.softDeleteAllDepartments(hospitalId);

        // Step 2: Upsert the incoming list.
        // bulkAdd now checks for existing records (including soft-deleted ones)
        // and reactivates them instead of creating duplicates.
        const results = {
            specialties: data.specialties.length > 0
                ? await hospitalRegistryRepository.bulkAddSpecialties(hospitalId, data.specialties)
                : [],
            subSpecialties: data.subSpecialties.length > 0
                ? await hospitalRegistryRepository.bulkAddSubSpecialties(hospitalId, data.subSpecialties)
                : [],
            departments: data.departments.length > 0
                ? await hospitalRegistryRepository.bulkAddDepartments(hospitalId, data.departments)
                : []
        };

        return results;
    }
}

export const hospitalRegistryService = new HospitalRegistryService();
