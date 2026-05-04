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

    // Soft-delete all existing entries for a hospital (used before re-adding)
    async softDeleteAllSpecialties(hospitalId: number) {
        await AppDataSource.getRepository(HospitalSpecialty)
            .update({ HospitalId: hospitalId, IsDeleted: false }, { IsDeleted: true });
    }

    async softDeleteAllSubSpecialties(hospitalId: number) {
        await AppDataSource.getRepository(HospitalSubSpecialty)
            .update({ HospitalId: hospitalId, IsDeleted: false }, { IsDeleted: true });
    }

    async softDeleteAllDepartments(hospitalId: number) {
        await AppDataSource.getRepository(HospitalDepartment)
            .update({ HospitalId: hospitalId, IsDeleted: false }, { IsDeleted: true });
    }

    // Upsert-style bulk add: reactivate existing (by name) or insert new
    async bulkAddSpecialties(hospitalId: number, items: { mainId?: number, name: string }[]) {
        const repo = AppDataSource.getRepository(HospitalSpecialty);
        const results: HospitalSpecialty[] = [];

        for (const item of items) {
            // Check if this specialty already exists for this hospital (including soft-deleted)
            const existing = await repo.findOne({
                where: { HospitalId: hospitalId, Name: item.name }
            });

            if (existing) {
                // Reactivate if soft-deleted, update mainId if needed
                existing.IsDeleted = false;
                existing.Status = true;
                if (item.mainId) existing.MainSpecialtyId = item.mainId;
                results.push(await repo.save(existing));
            } else {
                const data: Partial<HospitalSpecialty> = { HospitalId: hospitalId, Name: item.name };
                if (item.mainId) data.MainSpecialtyId = item.mainId;
                results.push(await repo.save(repo.create(data)));
            }
        }
        return results;
    }

    async bulkAddSubSpecialties(hospitalId: number, items: { mainId?: number, name: string }[]) {
        const repo = AppDataSource.getRepository(HospitalSubSpecialty);
        const results: HospitalSubSpecialty[] = [];

        for (const item of items) {
            const existing = await repo.findOne({
                where: { HospitalId: hospitalId, Name: item.name }
            });

            if (existing) {
                existing.IsDeleted = false;
                existing.Status = true;
                if (item.mainId) existing.MainSubSpecialtyId = item.mainId;
                results.push(await repo.save(existing));
            } else {
                const data: Partial<HospitalSubSpecialty> = { HospitalId: hospitalId, Name: item.name };
                if (item.mainId) data.MainSubSpecialtyId = item.mainId;
                results.push(await repo.save(repo.create(data)));
            }
        }
        return results;
    }

    async bulkAddDepartments(hospitalId: number, items: { mainId?: number, name: string }[]) {
        const repo = AppDataSource.getRepository(HospitalDepartment);
        const results: HospitalDepartment[] = [];

        for (const item of items) {
            const existing = await repo.findOne({
                where: { HospitalId: hospitalId, Name: item.name }
            });

            if (existing) {
                existing.IsDeleted = false;
                existing.Status = true;
                if (item.mainId) existing.MainDepartmentId = item.mainId;
                results.push(await repo.save(existing));
            } else {
                const data: Partial<HospitalDepartment> = { HospitalId: hospitalId, Name: item.name };
                if (item.mainId) data.MainDepartmentId = item.mainId;
                results.push(await repo.save(repo.create(data)));
            }
        }
        return results;
    }
}

export const hospitalRegistryRepository = new HospitalRegistryRepository();
