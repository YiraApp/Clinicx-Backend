import { AppDataSource } from "../../config/database.js";
import { User } from "../../models/Account/user.model.js";
import { Role } from "../../models/Account/role.model.js";
import { Organization } from "../../models/Organizations/organization.model.js";

export class DashboardRepository {
    async getAdminDashboardStats() {
        const userRepo = AppDataSource.getRepository(User);

        // 1. Basic User Stats
        const totalUsers = await userRepo.count();
        const activeUsers = await userRepo.count({
            where: { Status: true, IsDeleted: false }
        });

        // 2. Role Breakdown
        const roleStats = await userRepo
            .createQueryBuilder("user")
            .innerJoin("user.UserRoles", "userRole")
            .innerJoin("userRole.Role", "role")
            .select("role.RoleName", "roleName")
            .addSelect("COUNT(user.Id)", "count")
            .groupBy("role.RoleName")
            .getRawMany();

        // 3. Recent Activity
        const recentActivityQuery = `
            WITH ActivityData AS (
                SELECT 
                    CASE 
                        WHEN Path LIKE '%getAllHospitals%' THEN 'Hospital viewed'
                        WHEN Path LIKE '%getAllOrganizations%' THEN 'Organization viewed'
                        WHEN Path LIKE '%/api/hospitals%' AND Method = 'POST' THEN 'Hospital created'
                        WHEN Path LIKE '%/api/organizations%' AND Method = 'POST' THEN 'Organization created'
                        WHEN Path LIKE '%/api/hospitals%' AND Method IN ('PUT','PATCH') THEN 'Hospital updated'
                        WHEN Path LIKE '%/api/organizations%' AND Method IN ('PUT','PATCH') THEN 'Organization updated'
                        ELSE NULL
                    END AS Activity,

                    CASE 
                        WHEN Path LIKE '%hospitals%' AND ISJSON(Response) = 1
                            THEN COALESCE(
                                JSON_VALUE(Response, '$.data.hospitals[0].Name'),
                                JSON_VALUE(Response, '$.data[0].Name')
                            )
                    END AS HospitalName,

                    CASE 
                        WHEN Path LIKE '%organizations%' AND ISJSON(Response) = 1
                            THEN COALESCE(
                                JSON_VALUE(Response, '$.data.organizationStats[0].Name'),
                                JSON_VALUE(Response, '$.data[0].Name')
                            )
                    END AS OrganizationName,

                    RequestedOn
                FROM APILogs
            )
            SELECT TOP 20
                Activity + ' - ' + 
                COALESCE(HospitalName, OrganizationName, 'Unknown') AS ActivityMessage,
                CASE 
                    WHEN DATEDIFF(MINUTE, RequestedOn, GETUTCDATE()) < 60 
                        THEN CAST(DATEDIFF(MINUTE, RequestedOn, GETUTCDATE()) AS VARCHAR) + ' minutes ago'
                    WHEN DATEDIFF(HOUR, RequestedOn, GETUTCDATE()) < 24 
                        THEN CAST(DATEDIFF(HOUR, RequestedOn, GETUTCDATE()) AS VARCHAR) + ' hours ago'
                    ELSE CAST(DATEDIFF(DAY, RequestedOn, GETUTCDATE()) AS VARCHAR) + ' days ago'
                END AS TimeAgo,
                RequestedOn
            FROM ActivityData
            WHERE Activity IS NOT NULL
            ORDER BY RequestedOn DESC;
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

        const totalOrganizations = await orgRepo.count();
        const activeOrganizations = await orgRepo.count({ where: { Status: true } });
        const totalUsers = await userRepo.count({ where: { IsDeleted: false } });

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
