import { AppDataSource } from "../../config/database.js";
import { Hospital } from "../../models/Organizations/hospital.model.js";

export class HospitalRepository {
    private repo = AppDataSource.getRepository(Hospital);

    async createHospital(data: Partial<Hospital>): Promise<Hospital> {
        const hospital = this.repo.create(data);
        return await this.repo.save(hospital);
    }

    async findById(id: number): Promise<Hospital | null> {
        return await this.repo.findOne({
            where: { Id: id, IsDeleted: false },
            relations: ["Organization"]
        });
    }

    async findByCode(code: string): Promise<Hospital | null> {
        return await this.repo.findOne({ where: { HospitalCode: code, IsDeleted: false } });
    }

    async findByMobile(mobile: string): Promise<Hospital | null> {
        return await this.repo.findOne({ where: { MobileNumber: mobile, IsDeleted: false } });
    }

    async getAllHospitals(orgId?: number, page: number = 1, pageSize: number = 10, search?: string): Promise<{ data: Hospital[], total: number, stats: any }> {
        const skip = (page - 1) * pageSize;
        const query = this.repo.createQueryBuilder("h")
            .leftJoinAndSelect("h.Organization", "o")
            .where("h.IsDeleted = :isDeleted", { isDeleted: false });

        if (orgId) {
            query.andWhere("h.OrganizationId = :orgId", { orgId });
        }

        if (search) {
            query.andWhere("(h.Name LIKE :search OR h.HospitalCode LIKE :search OR h.Email LIKE :search)", { search: `%${search}%` });
        }

        const [data, total] = await query
            .orderBy("h.CreatedAt", "DESC")
            .skip(skip)
            .take(pageSize)
            .getManyAndCount();

        // Calculate Overview Stats
        const summaryWhere: any = { IsDeleted: false };
        if (orgId) summaryWhere.OrganizationId = orgId;
        const allHospitals = await this.repo.find({ where: summaryWhere });
        const summaryStats = {
            totalHospitals: total,
            activeBranches: allHospitals.filter(h => h.Status).length,
            totalBeds: allHospitals.reduce((sum, h) => sum + (h.TotalBeds || 0), 0),
            medicalStaff: 0 // Placeholder until Staff module is linked
        };

        return { data, total, stats: summaryStats };
    }

    async softDelete(id: number): Promise<void> {
        await this.repo.update(id, { IsDeleted: true, Status: false });
    }

    async updateStatus(id: number, status: boolean): Promise<void> {
        await this.repo.update(id, { Status: status, UpdatedAt: new Date() });
    }
}

export const hospitalRepository = new HospitalRepository();
