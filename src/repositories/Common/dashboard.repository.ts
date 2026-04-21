import { AppDataSource } from "../../config/database.js";
import { User } from "../../models/Account/user.model.js";
import { Role } from "../../models/Account/role.model.js";
import { Organization } from "../../models/Organizations/organization.model.js";

export class DashboardRepository {
    async getAdminDashboardStats(orgId?: number) {
        const userRepo = AppDataSource.getRepository(User);
        
        // 1. Basic User Stats (filtered by Org if necessary)
        const userQuery = userRepo.createQueryBuilder("user");
        if (orgId) {
            userQuery.innerJoin("user.UserRoles", "ur").where("ur.OrganizationId = :orgId", { orgId });
        }
        
        const totalUsers = await userQuery.getCount();
        const activeUsers = await userQuery.andWhere("user.Status = :status AND user.IsDeleted = :isDeleted", { status: true, isDeleted: false }).getCount();

        // 2. Role Breakdown
        const roleStatsQuery = userRepo
            .createQueryBuilder("user")
            .innerJoin("user.UserRoles", "userRole")
            .innerJoin("userRole.Role", "role");
        
        if (orgId) {
            roleStatsQuery.andWhere("userRole.OrganizationId = :orgId", { orgId });
        }

        const roleStats = await roleStatsQuery
            .select("role.RoleName", "roleName")
            .addSelect("COUNT(user.Id)", "count")
            .groupBy("role.RoleName")
            .getRawMany();

        // 3. Recent Activity (Focused on Audit Trailing)
        const recentActivityQuery = `
            SELECT TOP 20
                CASE 
                    WHEN Action = 'LOGIN' THEN 'User Logged In'
                    ELSE 
                        CASE 
                            WHEN EntityType = 'auth' THEN 'Account'
                            WHEN EntityType = 'users' THEN 'User'
                            WHEN EntityType = 'hospitals' THEN 'Hospital'
                            WHEN EntityType = 'organizations' THEN 'Organization'
                            WHEN EntityType = 'roles' THEN 'Role'
                            ELSE UPPER(LEFT(EntityType, 1)) + SUBSTRING(EntityType, 2, 100)
                        END + ' ' + 
                        CASE 
                            WHEN Action = 'CREATE' THEN 'Created'
                            WHEN Action = 'UPDATE' THEN 'Updated'
                            WHEN Action = 'DELETE' THEN 'Deleted'
                            ELSE ISNULL(Action, 'Activity')
                        END
                END AS ActivityMessage,
                UpdatedOn,
                ISNULL(NULLIF(LTRIM(RTRIM(ISNULL(u.FirstName, '') + ' ' + ISNULL(u.LastName, ''))), ''), 'System') as UserName,
                l.RoleName
            FROM APILogs l
            LEFT JOIN Users u ON l.UserId = u.Id
            WHERE Action IN ('CREATE', 'UPDATE', 'DELETE', 'LOGIN')
            ${orgId ? 'AND l.OrgId = ' + orgId : ''}
            ORDER BY UpdatedOn DESC;
        `;

        const recentActivity = await AppDataSource.query(recentActivityQuery);

        return {
            totalUsers,
            activeUsers,
            todayAppointments: 0,
            monthlyRevenue: 0,
            roleStats,
            recentActivity
        };
    }

    async getDashboardSummary(page: number = 1, pageSize: number = 10, orgId?: number, type?: string, search?: string) {
        const orgRepo = AppDataSource.getRepository(Organization);
        const userRepo = AppDataSource.getRepository(User);

        const totalOrganizations = await orgRepo.count();
        const activeOrganizations = await orgRepo.count({ where: { Status: true } });
        const totalUsers = await userRepo.count({ where: { IsDeleted: false } });
        
        // Count patients (role name like Patient)
        const totalPatients = await userRepo
            .createQueryBuilder("user")
            .innerJoin("user.UserRoles", "userRole")
            .innerJoin("userRole.Role", "role")
            .where("role.RoleName = :roleName", { roleName: "Patient" })
            .getCount();

        const query = orgRepo.createQueryBuilder("org");
        if (orgId) query.andWhere("org.Id = :orgId", { orgId });
        if (type && type !== "all" && type !== "ANY") query.andWhere("org.OrganizationType = :type", { type });
        if (search) {
            query.andWhere("(org.Name LIKE :search OR org.OrgCode LIKE :search)", { search: `%${search}%` });
        }

        const skip = (page - 1) * pageSize;
        const [orgs, total] = await query
            .orderBy("org.CreatedAt", "DESC")
            .skip(skip)
            .take(pageSize)
            .getManyAndCount();

        return {
            totalOrganizations,
            activeOrganizations,
            totalUsers,
            totalPatients,
            pagination: {
                page,
                pageSize,
                totalRecords: total,
                totalPages: Math.ceil(total / pageSize)
            },
            organizationStats: orgs
        };
    }
}

export const dashboardRepository = new DashboardRepository();
