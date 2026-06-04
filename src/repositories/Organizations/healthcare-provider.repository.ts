import { AppDataSource } from "../../config/database.js";
import { HealthcareProvider } from "../../models/Organizations/healthcare-provider.model.js";

export class HealthcareProviderRepository {
    private repo = AppDataSource.getRepository(HealthcareProvider);

    async saveProvider(data: Partial<HealthcareProvider>): Promise<HealthcareProvider> {
        const provider = this.repo.create(data);
        return await this.repo.save(provider);
    }

    async findByUserId(userId: string): Promise<HealthcareProvider | null> {
        console.log(`[Repository] Finding provider for UserId: ${userId}`);
        const provider = await this.repo.findOne({ 
            where: { UserId: userId, IsDeleted: false },
            relations: ["User", "Hospital"]
        });
        console.log(`[Repository] Provider find result for ${userId}:`, provider ? `Found (ID: ${provider.Id})` : "Not Found");
        return provider;
    }

    async findByHospital(hospitalId: number): Promise<HealthcareProvider[]> {
        return await this.repo.find({ 
            where: { HospitalId: hospitalId, IsDeleted: false },
            relations: ["User"]
        });
    }

    async getDoctors(page: number, pageSize: number, filters: any): Promise<any> {
        const skip = (page - 1) * pageSize;
        const query = this.repo.createQueryBuilder("hp")
            .innerJoinAndSelect("hp.User", "u")
            .innerJoinAndSelect("hp.Hospital", "h")
            .where("hp.IsDeleted = :isDeleted", { isDeleted: false });

        if (filters.organizationId) {
            query.andWhere("h.OrganizationId = :organizationId", { organizationId: filters.organizationId });
        }

        if (filters.hospitalId) {
            query.andWhere("hp.HospitalId = :hospitalId", { hospitalId: filters.hospitalId });
        }

        if (filters.search) {
            query.andWhere(
                "(u.FirstName LIKE :search OR u.LastName LIKE :search OR (u.FirstName + ' ' + u.LastName) LIKE :search OR hp.Specialty LIKE :search OR hp.Department LIKE :search)",
                { search: `%${filters.search}%` }
            );
        }


        if (filters.status !== undefined) {
            const statusVal = filters.status === true || filters.status === "active";
            query.andWhere("u.Status = :status", { status: statusVal ? 1 : 0 });
        }



        const [data, total] = await query.skip(skip).take(pageSize).getManyAndCount();

        // Calculate summary stats
        const statsQuery = this.repo.createQueryBuilder("hp")
            .innerJoin("hp.User", "u")
            .innerJoin("hp.Hospital", "h")
            .where("hp.IsDeleted = :isDeleted", { isDeleted: false });

        if (filters.organizationId) {
            statsQuery.andWhere("h.OrganizationId = :organizationId", { organizationId: filters.organizationId });
        }
        if (filters.hospitalId) {
            statsQuery.andWhere("hp.HospitalId = :hospitalId", { hospitalId: filters.hospitalId });
        }
        if (filters.search) {
            statsQuery.andWhere(
                "(u.FirstName LIKE :search OR u.LastName LIKE :search OR (u.FirstName + ' ' + u.LastName) LIKE :search OR hp.Specialty LIKE :search OR hp.Department LIKE :search)",
                { search: `%${filters.search}%` }
            );
        }
        if (filters.status !== undefined) {
            const statusVal = filters.status === true || filters.status === "active";
            statsQuery.andWhere("u.Status = :status", { status: statusVal ? 1 : 0 });
        }

        const stats = await statsQuery
            .select("COUNT(DISTINCT hp.UserId)", "total")
            .addSelect("COUNT(DISTINCT CASE WHEN u.Status = 1 THEN hp.UserId END)", "active")
            .getRawOne();



        return {
            summary: {
                totalDoctors: parseInt(stats.total) || 0,
                activeDoctors: parseInt(stats.active) || 0,
                inactiveDoctors: (parseInt(stats.total) || 0) - (parseInt(stats.active) || 0)
            },
            data: {
                data,
                total,
                page,
                pageSize,
                totalPages: Math.ceil(total / pageSize)
            }
        };
    }


    async getDoctorById(id: number, userId?: string): Promise<HealthcareProvider | null> {
        const query = this.repo.createQueryBuilder("hp")
            .leftJoinAndSelect("hp.User", "u")
            .leftJoinAndSelect("u.PermanentAddress", "pa")
            .leftJoinAndSelect("hp.Hospital", "h")
            .leftJoinAndSelect("hp.Availability", "avail", "avail.IsDeleted = 0")
            .where("hp.Id = :id AND hp.IsDeleted = 0", { id });

        if (userId) {
            query.andWhere("hp.UserId = :userId", { userId });
        }

        return await query.getOne();
    }

    async getAllProvidersByUserId(userId: string, organizationId?: number): Promise<HealthcareProvider[]> {
        const query = this.repo.createQueryBuilder("hp")
            .leftJoinAndSelect("hp.User", "u")
            .leftJoinAndSelect("u.PermanentAddress", "pa")
            .leftJoinAndSelect("hp.Hospital", "h")
            .leftJoinAndSelect("hp.Availability", "avail", "avail.IsDeleted = 0")
            .where("hp.UserId = :userId AND hp.IsDeleted = 0", { userId });

        if (organizationId) {
            query.andWhere("h.OrganizationId = :organizationId", { organizationId });
        }

        return await query.orderBy("hp.CreatedAt", "ASC").getMany();
    }

    async findByUserIdAndHospital(userId: string, hospitalId: number): Promise<HealthcareProvider | null> {
        return await this.repo.findOne({
            where: { UserId: userId, HospitalId: hospitalId, IsDeleted: false }
        });
    }

    async updateDoctor(id: number, data: Partial<HealthcareProvider>): Promise<void> {
        await this.repo.update(id, { ...data, UpdatedAt: new Date() });
    }
}



export const healthcareProviderRepository = new HealthcareProviderRepository();
