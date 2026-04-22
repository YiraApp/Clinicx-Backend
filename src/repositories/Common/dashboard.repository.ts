import { AppDataSource } from "../../config/database.js";
import { User } from "../../models/Account/user.model.js";
import { Role } from "../../models/Account/role.model.js";
import { Organization } from "../../models/Organizations/organization.model.js";

export class DashboardRepository {
    async getAdminDashboardStats(orgId?: number, hospId?: number) {
        const userRepo = AppDataSource.getRepository(User);

        // 1. Basic User Stats (filtered by Org if necessary)
        const userQuery = userRepo.createQueryBuilder("user");
        if (orgId || hospId) {
            userQuery.innerJoin("user.UserRoles", "ur");
            if (orgId) {
                userQuery.andWhere("ur.OrganizationId = :orgId", { orgId });
            }
            if (hospId) {
                userQuery.andWhere("ur.HospitalId = :hospId", { hospId });
            }
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
        if (hospId) {
            roleStatsQuery.andWhere("userRole.HospitalId = :hospId", { hospId });
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
            ${hospId ? 'AND l.HospitalId = ' + hospId : ''}
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

    async getAnalyticsStats() {
        const userRepo = AppDataSource.getRepository(User);
        const orgRepo = AppDataSource.getRepository(Organization);

        // 1. Basic Stats
        const totalUsers = await userRepo.count({ where: { IsDeleted: false } });
        const activeUsers = await userRepo.count({ where: { Status: true, IsDeleted: false } });
        const totalOrgs = await orgRepo.count({ where: { Status: true } });

        // 2. Growth Trends (Monthly)
        const userGrowthQuery = `
            SELECT 
                FORMAT(CreatedAt, 'MMM yyyy') as month,
                COUNT(Id) as count
            FROM Users
            WHERE CreatedAt >= DATEADD(MONTH, -6, GETDATE())
            GROUP BY FORMAT(CreatedAt, 'MMM yyyy'), YEAR(CreatedAt), MONTH(CreatedAt)
            ORDER BY YEAR(CreatedAt), MONTH(CreatedAt)
        `;

        const orgGrowthQuery = `
            SELECT 
                FORMAT(CreatedAt, 'MMM yyyy') as month,
                COUNT(Id) as count
            FROM Organizations
            WHERE CreatedAt >= DATEADD(MONTH, -6, GETDATE())
            GROUP BY FORMAT(CreatedAt, 'MMM yyyy'), YEAR(CreatedAt), MONTH(CreatedAt)
            ORDER BY YEAR(CreatedAt), MONTH(CreatedAt)
        `;

        const [userTrends, orgTrends] = await Promise.all([
            AppDataSource.query(userGrowthQuery),
            AppDataSource.query(orgGrowthQuery)
        ]);

        // 3. Organization Distribution
        const distribution = await orgRepo
            .createQueryBuilder("org")
            .select("org.OrganizationType", "type")
            .addSelect("COUNT(org.Id)", "count")
            .groupBy("org.OrganizationType")
            .getRawMany();

        // 4. Top Organizations (By User Count)
        const topOrgsQuery = `
            SELECT TOP 5
                o.Name as name,
                COUNT(ur.UserId) as userCount
            FROM Organizations o
            LEFT JOIN UserRoles ur ON o.Id = ur.OrganizationId
            GROUP BY o.Name
            ORDER BY userCount DESC
        `;
        const topOrgs = await AppDataSource.query(topOrgsQuery);

        return {
            totalUsers,
            activeUsers,
            totalOrganizations: totalOrgs,
            totalAppointments: 0, // Placeholder
            totalRevenue: 0, // Placeholder
            growthTrends: {
                users: userTrends,
                organizations: orgTrends
            },
            distribution,
            topOrganizations: topOrgs
        };
    }

    async getDashboardSummary(page: number = 1, pageSize: number = 10, orgId?: number, type?: string, search?: string) {
        const orgRepo = AppDataSource.getRepository(Organization);
        const userRepo = AppDataSource.getRepository(User);

        // 1. Build Base Filtered Query for Organizations
        const query = orgRepo.createQueryBuilder("org");
        if (orgId) query.andWhere("org.Id = :orgId", { orgId });
        if (type && type !== "all" && type !== "ANY") query.andWhere("org.OrganizationType = :type", { type });
        if (search) {
            query.andWhere("(org.Name LIKE :search OR org.OrgCode LIKE :search)", { search: `%${search}%` });
        }

        // 2. Filter-Aware Summary Stats
        const totalOrganizations = await query.clone().getCount();
        const activeOrganizations = await query.clone().andWhere("org.Status = :activeStatus", { activeStatus: true }).getCount();

        // Count users in filtered organizations
        const userSummaryQuery = userRepo.createQueryBuilder("user")
            .innerJoin("user.UserRoles", "ur")
            .innerJoin("ur.Organization", "org")
            .where("user.IsDeleted = 0");

        if (orgId) userSummaryQuery.andWhere("org.Id = :orgId", { orgId });
        if (type && type !== "all" && type !== "ANY") userSummaryQuery.andWhere("org.OrganizationType = :type", { type });
        if (search) {
            userSummaryQuery.andWhere("(org.Name LIKE :search OR org.OrgCode LIKE :search)", { search: `%${search}%` });
        }

        const totalUsers = await userSummaryQuery.clone().select("COUNT(DISTINCT user.Id)", "count").getRawOne();

        const totalPatients = await userSummaryQuery.clone()
            .innerJoin("ur.Role", "role")
            .andWhere("role.RoleName = :roleName", { roleName: "Patient" })
            .select("COUNT(DISTINCT user.Id)", "count")
            .getRawOne();

        // 3. Paginated Data
        const skip = (page - 1) * pageSize;
        const [orgs, total] = await query
            .orderBy("org.CreatedAt", "DESC")
            .skip(skip)
            .take(pageSize)
            .getManyAndCount();

        return {
            totalOrganizations,
            activeOrganizations,
            totalUsers: parseInt(totalUsers.count || "0"),
            totalPatients: parseInt(totalPatients.count || "0"),
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
