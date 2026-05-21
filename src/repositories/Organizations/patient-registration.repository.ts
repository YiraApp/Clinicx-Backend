import { AppDataSource } from "../../config/database.js";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import { PatientInsurance } from "../../models/Organizations/patient-insurance.model.js";

export class PatientRegistrationRepository {
    private repo = AppDataSource.getRepository(PatientRegistration);

    async findByUserId(userId: string, organizationId?: number): Promise<PatientRegistration | null> {
        const where: any = { UserId: userId, IsDeleted: false };
        if (organizationId) where.OrganizationId = organizationId;
        return await this.repo.findOne({ where });
    }

    async findByUserAndHospital(userId: string, hospitalId: number): Promise<PatientRegistration | null> {
        return await this.repo.findOne({
            where: { UserId: userId, HospitalId: hospitalId, IsDeleted: false }
        });
    }

    async save(registration: PatientRegistration): Promise<PatientRegistration> {
        return await this.repo.save(registration);
    }

    async getPatients(page: number = 1, pageSize: number = 10, filters: any): Promise<any> {
        const skip = (page - 1) * pageSize;

        const query = this.repo.createQueryBuilder("pr")
            .innerJoinAndSelect("pr.User", "u")
            .innerJoinAndSelect("u.UserRoles", "ur", "ur.IsDeleted = 0 AND ur.Status = 1 AND ur.RoleId = :patientRoleId AND ur.OrganizationId = pr.OrganizationId", { patientRoleId: "4FC67429-28AE-4106-93EF-436228282ED0" })
            .leftJoinAndSelect("ur.Organization", "urOrg")
            .leftJoinAndSelect("ur.Hospital", "urHosp")
            .leftJoinAndSelect("u.PermanentAddress", "pa")
            .leftJoinAndSelect("pr.Organization", "org")
            .leftJoinAndSelect("pr.Hospital", "h")
            .where("pr.IsDeleted = 0 AND u.IsDeleted = 0");

        if (filters.organizationId) {
            query.andWhere("pr.OrganizationId = :orgId", { orgId: filters.organizationId });
        }

        if (filters.hospitalId) {
            query.andWhere("(pr.HospitalId = :hospId OR ur.HospitalId = :hospId)", { hospId: filters.hospitalId });
        }

        if (filters.gender && filters.gender !== "all") {
            query.andWhere("LOWER(u.Gender) = LOWER(:gender)", { gender: filters.gender });
        }
        if (filters.status !== undefined && filters.status !== "all") {
            const statusVal = filters.status === "active" || filters.status === true;
            query.andWhere("u.Status = :status", { status: statusVal ? 1 : 0 });
        }


        if (filters.search) {
            query.andWhere(
                "(u.FirstName LIKE :search OR u.LastName LIKE :search OR (u.FirstName + ' ' + u.LastName) LIKE :search OR u.PhoneNumber LIKE :search OR u.Email LIKE :search OR CAST(pr.Id AS NVARCHAR(MAX)) LIKE :search OR CAST(u.Id AS NVARCHAR(MAX)) LIKE :search)",
                { search: `%${filters.search}%` }
            );
        }



        query.orderBy("pr.CreatedAt", "DESC");


        const [registrations, total] = await query.skip(skip).take(pageSize).getManyAndCount();

        // Batch-load insurance for all returned patients in one query
        const userIds = registrations.map(pr => pr.UserId).filter(Boolean);
        const insuranceMap = new Map<string, PatientInsurance>();
        if (userIds.length > 0) {
            const insurances = await AppDataSource.getRepository(PatientInsurance)
                .createQueryBuilder("ins")
                .where("ins.UserId IN (:...userIds)", { userIds })
                .andWhere("ins.IsDeleted = :deleted", { deleted: false })
                .getMany();
            insurances.forEach(ins => insuranceMap.set(ins.UserId.toUpperCase(), ins));
        }

        // Summary stats for this org/hosp context
        const statsQuery = this.repo.createQueryBuilder("pr")
            .innerJoin("pr.User", "u")
            .innerJoin("u.UserRoles", "ur", "ur.IsDeleted = 0 AND ur.Status = 1 AND ur.RoleId = :patientRoleId AND ur.OrganizationId = pr.OrganizationId", { patientRoleId: "4FC67429-28AE-4106-93EF-436228282ED0" })
            .leftJoin("pr.Hospital", "h")
            .where("pr.IsDeleted = 0 AND u.IsDeleted = 0");


        if (filters.organizationId) statsQuery.andWhere("pr.OrganizationId = :orgId", { orgId: filters.organizationId });
        if (filters.hospitalId) statsQuery.andWhere("(pr.HospitalId = :hospId OR ur.HospitalId = :hospId)", { hospId: filters.hospitalId });

        if (filters.gender && filters.gender !== "all") {
            statsQuery.andWhere("LOWER(u.Gender) = LOWER(:gender)", { gender: filters.gender });
        }
        if (filters.status !== undefined && filters.status !== "all") {
            const statusVal = filters.status === "active" || filters.status === true;
            statsQuery.andWhere("u.Status = :status", { status: statusVal ? 1 : 0 });
        }


        if (filters.search) {
            statsQuery.andWhere(
                "(u.FirstName LIKE :search OR u.LastName LIKE :search OR (u.FirstName + ' ' + u.LastName) LIKE :search OR u.PhoneNumber LIKE :search OR u.Email LIKE :search OR CAST(pr.Id AS NVARCHAR(MAX)) LIKE :search OR CAST(u.Id AS NVARCHAR(MAX)) LIKE :search)",
                { search: `%${filters.search}%` }
            );
        }






        const stats = await statsQuery
            .select("COUNT(pr.Id)", "total")
            .addSelect("SUM(CASE WHEN u.Status = 1 THEN 1 ELSE 0 END)", "active")
            .getRawOne();


        const patients = registrations.map(pr => {
            const ins = insuranceMap.get(pr.UserId.toUpperCase());
            return {
                id: pr.Id,
                userId: pr.UserId,
                firstName: pr.User?.FirstName,
                lastName: pr.User?.LastName,
                name: `${pr.User?.FirstName || ""} ${pr.User?.LastName || ""}`.trim(),
                email: pr.User?.Email,
                phone: pr.User?.PhoneNumber,
                countryCode: pr.User?.CountryCode || "91",
                gender: pr.User?.Gender,
                status: pr.User?.Status ? "active" : "inactive",
                dateOfBirth: pr.User?.DateOfBirth,
                bloodGroup: pr.User?.BloodGroup,
                address: pr.User?.PermanentAddress?.AddressLine1,
                city: pr.User?.PermanentAddress?.City,
                state: pr.User?.PermanentAddress?.State,
                pincode: pr.User?.PermanentAddress?.Pincode,
                emergencyContactName: pr.User?.EmergencyContactName,
                emergencyContactPhone: pr.User?.EmergencyContactPhone,
                allergies: pr.Allergies,
                medicalHistory: pr.MedicalHistory,
                insuranceProvider: ins?.InsuranceProvider || null,
                insuranceNumber: ins?.InsuranceNumber || null,
                insuranceStatus: ins?.Status ?? null,
                organizationName: pr.Organization?.Name || pr.User?.UserRoles?.[0]?.Organization?.Name,
                organizationCode: pr.Organization?.OrgCode || pr.User?.UserRoles?.[0]?.Organization?.OrgCode,
                orgCode: pr.Organization?.OrgCode || pr.User?.UserRoles?.[0]?.Organization?.OrgCode,
                hospitalName: pr.Hospital?.Name || pr.User?.UserRoles?.[0]?.Hospital?.Name,
                hospitalCode: pr.Hospital?.HospitalCode || pr.User?.UserRoles?.[0]?.Hospital?.HospitalCode,
                roleId: pr.User?.UserRoles?.[0]?.RoleId,
                roleName: "Patient",
                createdAt: pr.CreatedAt,
            };
        });

        return {
            summary: {
                totalUsers: parseInt(stats.total) || 0,
                activeUsers: parseInt(stats.active) || 0,
                inactiveUsers: (parseInt(stats.total) || 0) - (parseInt(stats.active) || 0)
            },
            patients,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        };
    }
}

export const patientRegistrationRepository = new PatientRegistrationRepository();
