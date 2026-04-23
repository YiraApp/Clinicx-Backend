import { AppDataSource } from "../../config/database.js";
import { HospitalSpecialty } from "../../models/Organizations/hospital-specialty.model.js";
import { HospitalSubSpecialty } from "../../models/Organizations/hospital-subspecialty.model.js";
import { HospitalDepartment } from "../../models/Organizations/hospital-department.model.js";

export class HospitalRegistryRepository {
    // Specialties
    async getHospitalSpecialties(hospitalId: number) {
        return await AppDataSource.getRepository(HospitalSpecialty).find({
            where: { HospitalId: hospitalId, IsDeleted: false },
            relations: ["MainSpecialty"],
            order: { Name: "ASC" }
        });
    }

    async addHospitalSpecialty(data: Partial<HospitalSpecialty>) {
        const repo = AppDataSource.getRepository(HospitalSpecialty);
        const entity = repo.create(data);
        return await repo.save(entity);
    }

    // SubSpecialties
    async getHospitalSubSpecialties(hospitalId: number) {
        return await AppDataSource.getRepository(HospitalSubSpecialty).find({
            where: { HospitalId: hospitalId, IsDeleted: false },
            relations: ["MainSubSpecialty"],
            order: { Name: "ASC" }
        });
    }

    async addHospitalSubSpecialty(data: Partial<HospitalSubSpecialty>) {
        const repo = AppDataSource.getRepository(HospitalSubSpecialty);
        const entity = repo.create(data);
        return await repo.save(entity);
    }

    // Departments
    async getHospitalDepartments(hospitalId: number) {
        return await AppDataSource.getRepository(HospitalDepartment).find({
            where: { HospitalId: hospitalId, IsDeleted: false },
            relations: ["MainDepartment"],
            order: { Name: "ASC" }
        });
    }

    async addHospitalDepartment(data: Partial<HospitalDepartment>) {
        const repo = AppDataSource.getRepository(HospitalDepartment);
        const entity = repo.create(data);
        return await repo.save(entity);
    }

    async bulkAddSpecialties(hospitalId: number, items: { mainId?: number, name: string }[]) {
        const repo = AppDataSource.getRepository(HospitalSpecialty);
        const dataToSave = items.map(item => {
            const data: any = {
                HospitalId: hospitalId,
                Name: item.name
            };
            if (item.mainId) data.MainSpecialtyId = item.mainId;
            return data;
        });
        return await repo.save(dataToSave);
    }

    async bulkAddSubSpecialties(hospitalId: number, items: { mainId?: number, name: string }[]) {
        const repo = AppDataSource.getRepository(HospitalSubSpecialty);
        const dataToSave = items.map(item => {
            const data: any = {
                HospitalId: hospitalId,
                Name: item.name
            };
            if (item.mainId) data.MainSubSpecialtyId = item.mainId;
            return data;
        });
        return await repo.save(dataToSave);
    }

    async bulkAddDepartments(hospitalId: number, items: { mainId?: number, name: string }[]) {
        const repo = AppDataSource.getRepository(HospitalDepartment);
        const dataToSave = items.map(item => {
            const data: any = {
                HospitalId: hospitalId,
                Name: item.name
            };
            if (item.mainId) data.MainDepartmentId = item.mainId;
            return data;
        });
        return await repo.save(dataToSave);
    }
}

export const hospitalRegistryRepository = new HospitalRegistryRepository();
