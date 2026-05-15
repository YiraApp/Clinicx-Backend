import { AppDataSource } from "../../config/database.js";
import { Hospital } from "../../models/Organizations/hospital.model.js";
import { HealthcareProvider } from "../../models/Organizations/healthcare-provider.model.js";

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

    async getAllHospitals(orgId?: number, page: number = 1, pageSize: number = 10, search?: string, hospitalId?: number): Promise<{ data: Hospital[], total: number, stats: any }> {
        const skip = (page - 1) * pageSize;
        const query = this.repo.createQueryBuilder("h")
            .leftJoinAndSelect("h.Organization", "o")
            .where("h.IsDeleted = :isDeleted", { isDeleted: false });

        if (orgId) {
            query.andWhere("h.OrganizationId = :orgId", { orgId });
        }

        if (hospitalId) {
            query.andWhere("h.Id = :hospitalId", { hospitalId });
        }

        if (search) {
            query.andWhere("(h.Name LIKE :search OR h.HospitalCode LIKE :search OR h.Email LIKE :search)", { search: `%${search}%` });
        }

        const [data, total] = await query
            .orderBy("h.CreatedAt", "DESC")
            .skip(skip)
            .take(pageSize)
            .getManyAndCount();

        // Manual count query to avoid model-level integration
        const hospitalIds = data.map(h => h.Id);
        if (hospitalIds.length > 0) {
            const counts = await AppDataSource.getRepository(HealthcareProvider)
                .createQueryBuilder("hp")
                .select("hp.HospitalId", "hospitalId")
                .addSelect("COUNT(hp.Id)", "count")
                .where("hp.HospitalId IN (:...ids)", { ids: hospitalIds })
                .andWhere("hp.IsDeleted = :hpDeleted", { hpDeleted: false })
                .groupBy("hp.HospitalId")
                .getRawMany();

            data.forEach((h: any) => {
                const match = counts.find(c => c.hospitalId === h.Id);
                h.MedicalStaff = match ? parseInt(match.count) : 0;
            });
        }

        // Calculate Overview Stats
        const summaryWhere: any = { IsDeleted: false };
        if (orgId) summaryWhere.OrganizationId = orgId;
        const allHospitals = await this.repo.find({ where: summaryWhere });
        // Calculate Medical Staff Count for summary
        const providerRepo = AppDataSource.getRepository(HealthcareProvider);
        const providerQuery = providerRepo.createQueryBuilder("hp")
            .where("hp.IsDeleted = :isDeleted", { isDeleted: false });
        
        if (orgId) {
            providerQuery.innerJoin("hp.Hospital", "h")
                .andWhere("h.OrganizationId = :orgId", { orgId });
        }
        
        const medicalStaffCount = await providerQuery.getCount();

        const summaryStats = {
            totalHospitals: total,
            activeBranches: allHospitals.filter(h => h.Status).length,
            totalBeds: allHospitals.reduce((sum, h) => sum + (h.TotalBeds || 0), 0),
            medicalStaff: medicalStaffCount
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
