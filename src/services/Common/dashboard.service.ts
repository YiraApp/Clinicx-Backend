import { AppDataSource } from "../../config/database.js";
import { Organization } from "../../models/Organizations/organization.model.js";
import { UserRole } from "../../models/Account/userrole.model.js";
import { User } from "../../models/Account/user.model.js";
import type { IDashboardService, DashboardSummary } from "../../interfaces/Service/Common/IDashboardService.js";

export class DashboardService implements IDashboardService {
    private PATIENT_ROLE_ID = "4FC67429-28AE-4106-93EF-436228282ED0";

    async getDashboardSummary(page: number = 1, pageSize: number = 10, orgId?: number, type?: string, search?: string): Promise<DashboardSummary> {
        const orgRepo = AppDataSource.getRepository(Organization);
        const userRepo = AppDataSource.getRepository(User);
        const userRoleRepo = AppDataSource.getRepository(UserRole);

        // 1. Total & Active Organizations
        let whereCondition: any = { IsDeleted: false }; // Added IsDeleted check if applicable, but looking at line 16 it was empty.

        if (orgId) {
            whereCondition.Id = orgId;
        }

        if (type && type !== "all") {
            whereCondition.OrganizationType = type;
        }

        // We use query builder for count if search is provided to keep it consistent
        const countQuery = orgRepo.createQueryBuilder("org").where("1=1");
        
        if (orgId) {
            countQuery.andWhere("org.Id = :orgId", { orgId });
        }
        if (type && type !== "all") {
            countQuery.andWhere("LOWER(org.OrganizationType) = LOWER(:type)", { type });
        }
        if (search) {
            countQuery.andWhere("(org.Name LIKE :search OR org.OrgCode LIKE :search OR org.Email LIKE :search)", { search: `%${search}%` });
        }

        const totalOrganizations = await countQuery.getCount();

        const activeCountQuery = orgRepo.createQueryBuilder("org").where("org.Status = :status", { status: true });
        if (orgId) {
            activeCountQuery.andWhere("org.Id = :orgId", { orgId });
        }
        if (type && type !== "all") {
            activeCountQuery.andWhere("LOWER(org.OrganizationType) = LOWER(:type)", { type });
        }
        if (search) {
            activeCountQuery.andWhere("(org.Name LIKE :search OR org.OrgCode LIKE :search OR org.Email LIKE :search)", { search: `%${search}%` });
        }
        const activeOrganizations = await activeCountQuery.getCount();

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

        if (type && type !== "all") {
            query.andWhere("LOWER(org.OrganizationType) = LOWER(:type)", { type });
        }

        if (search) {
            query.andWhere("(org.Name LIKE :search OR org.OrgCode LIKE :search OR org.Email LIKE :search)", { search: `%${search}%` });
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

        return result;
    }
}

export const dashboardService = new DashboardService();
