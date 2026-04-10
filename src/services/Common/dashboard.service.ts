import { AppDataSource } from "../../config/database.js";
import { Organization } from "../../models/Organizations/organization.model.js";
import { UserRole } from "../../models/Account/userrole.model.js";
import { User } from "../../models/Account/user.model.js";
import type { IDashboardService, DashboardSummary } from "../../interfaces/Service/Common/IDashboardService.js";

export class DashboardService implements IDashboardService {
    private PATIENT_ROLE_ID = "4FC67429-28AE-4106-93EF-436228282ED0";

    async getDashboardSummary(page: number = 1, pageSize: number = 10): Promise<DashboardSummary> {
        const orgRepo = AppDataSource.getRepository(Organization);
        const userRepo = AppDataSource.getRepository(User);
        const userRoleRepo = AppDataSource.getRepository(UserRole);

        // 1. Total & Active Organizations
        const totalOrganizations = await orgRepo.count();
        const activeOrganizations = await orgRepo.count({ where: { Status: true } });

        // 2. Total Users (Distinct Users)
        const totalUsers = await userRepo.count({ where: { IsDeleted: false } });

        // 3. Total Patients (Users with Patient Role)
        const totalPatients = await userRoleRepo.count({
            where: { RoleId: this.PATIENT_ROLE_ID, IsDeleted: false }
        });

        // 4. Organization-wise Stats with pagination (latest first)
        const offset = (page - 1) * pageSize;

        const organizationStats = await orgRepo
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
            .addSelect(`COUNT(DISTINCT CASE WHEN ur.RoleId = '${this.PATIENT_ROLE_ID}' THEN ur.UserId END)`, "PatientCount")
            .groupBy("org.Id, org.Name, org.OrgCode, org.OrganizationType, org.Status, org.Email, org.MobileNumber, org.Website, org.Address, org.CreatedAt")
            .orderBy("org.CreatedAt", "DESC")
            .offset(offset)
            .limit(pageSize)
            .getRawMany();

        const totalPages = Math.ceil(totalOrganizations / pageSize);

        return {
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
    }
}

export const dashboardService = new DashboardService();
