import { AppDataSource } from "../../config/database.js";
import { Organization } from "../../models/Organizations/organization.model.js";
import { UserRole } from "../../models/Account/userrole.model.js";
import { User } from "../../models/Account/user.model.js";
import { redisService } from "./redis.service.js";
import { CacheKeys } from "../../utils/cache.keys.js";
import type { IDashboardService, DashboardSummary } from "../../interfaces/Service/Common/IDashboardService.js";

export class DashboardService implements IDashboardService {
    private PATIENT_ROLE_ID = "4FC67429-28AE-4106-93EF-436228282ED0";

    async getDashboardSummary(page: number = 1, pageSize: number = 10, orgId?: number): Promise<DashboardSummary> {
        const cacheKey = CacheKeys.DASHBOARD_SUMMARY(page, pageSize, orgId);
        const cachedSummary = await redisService.get<DashboardSummary>(cacheKey);

        if (cachedSummary) {
            console.log(`[Redis] Cache HIT: ${cacheKey}`);
            return cachedSummary;
        }

        console.log(`[Redis] Cache MISS: ${cacheKey}`);
        const orgRepo = AppDataSource.getRepository(Organization);
        const userRepo = AppDataSource.getRepository(User);
        const userRoleRepo = AppDataSource.getRepository(UserRole);

        // 1. Total & Active Organizations
        let totalOrganizations = await orgRepo.count();
        let activeOrganizations = await orgRepo.count({ where: { Status: true } });

        if (orgId) {
            totalOrganizations = await orgRepo.count({ where: { Id: orgId } });
            activeOrganizations = await orgRepo.count({ where: { Id: orgId, Status: true } });
        }

        // 2. Total Users (Distinct Users)
        const userQuery = userRepo.createQueryBuilder("u").where("u.IsDeleted = 0");
        if (orgId) {
            userQuery.innerJoin(UserRole, "ur", "ur.UserId = u.Id AND ur.OrganizationId = :orgId", { orgId });
        }
        const totalUsers = await userQuery.getCount();

        // 3. Total Patients (Users with Patient Role)
        const patientQuery = userRoleRepo.createQueryBuilder("ur")
            .where("ur.RoleId = :roleId", { roleId: this.PATIENT_ROLE_ID })
            .andWhere("ur.IsDeleted = 0");
        if (orgId) {
            patientQuery.andWhere("ur.OrganizationId = :orgId", { orgId });
        }
        const totalPatients = await patientQuery.getCount();

        // 4. Organization-wise Stats with pagination (latest first)
        const offset = (page - 1) * pageSize;

        const query = orgRepo
            .createQueryBuilder("org")
            .leftJoin(UserRole, "ur", "ur.OrganizationId = org.Id AND ur.IsDeleted = 0")
            .select("org.Id", "Id")
            .addSelect("org.Name", "Name")
            .addSelect("org.OrgCode", "OrgCode")
            .addSelect("org.OrganizationType", "OrganizationType")
            .addSelect("org.Status", "Status")
            .addSelect("org.Email", "Email")
            .addSelect("org.MobileNumber", "MobileNumber")
            .addSelect("org.Website", "Website")
            .addSelect("org.Address", "Address")
            .addSelect("org.CreatedAt", "CreatedAt")
            .addSelect("COUNT(DISTINCT ur.UserId)", "UserCount")
            .addSelect(`COUNT(DISTINCT CASE WHEN ur.RoleId = '${this.PATIENT_ROLE_ID}' THEN ur.UserId END)`, "PatientCount");

        if (orgId) {
            query.andWhere("org.Id = :orgId", { orgId });
        }

        const organizationStats = await query
            .groupBy("org.Id, org.Name, org.OrgCode, org.OrganizationType, org.Status, org.Email, org.MobileNumber, org.Website, org.Address, org.CreatedAt")
            .orderBy("org.CreatedAt", "DESC")
            .offset(offset)
            .limit(pageSize)
            .getRawMany();

        const totalPages = Math.ceil(totalOrganizations / pageSize);

        const result: DashboardSummary = {
            totalOrganizations,
            activeOrganizations,
            totalUsers,
            totalPatients,
            pagination: {
                page,
                pageSize,
                totalRecords: totalOrganizations,
                totalPages
            },
            organizationStats: organizationStats.map(stat => ({
                ...stat,
                UserCount: parseInt(stat.UserCount),
                PatientCount: parseInt(stat.PatientCount)
            }))
        };

        // Cache the result
        await redisService.set(cacheKey, result);

        return result;
    }
}

export const dashboardService = new DashboardService();
