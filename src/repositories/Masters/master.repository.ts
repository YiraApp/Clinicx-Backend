import { AppDataSource } from "../../config/database.js";
import { MainSpecialty } from "../../models/Masters/main-specialty.model.js";
import { MainSubSpecialty } from "../../models/Masters/main-subspecialty.model.js";
import { MainDepartment } from "../../models/Masters/main-department.model.js";

export class MasterRepository {
    async getAllSpecialties() {
        return await AppDataSource.getRepository(MainSpecialty).find({
            where: { IsDeleted: false, Status: true },
            order: { Name: "ASC" }
        });
    }

    async getAllSubSpecialties(specialtyId?: number) {
        const where: any = { IsDeleted: false, Status: true };
        if (specialtyId) where.MainSpecialtyId = specialtyId;
        
        return await AppDataSource.getRepository(MainSubSpecialty).find({
            where,
            order: { Name: "ASC" }
        });
    }

    async getAllDepartments() {
        return await AppDataSource.getRepository(MainDepartment).find({
            where: { IsDeleted: false, Status: true },
            order: { Name: "ASC" }
        });
    }
}

export const masterRepository = new MasterRepository();
