import { AppDataSource } from "../../config/database.js";
import { User } from "../../models/Account/user.model.js";
import { Role } from "../../models/Account/role.model.js";
import { Organization } from "../../models/Organizations/organization.model.js";
import { UserRole } from "../../models/Account/userrole.model.js";

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
            FROM APILogs l WITH (NOLOCK)
            LEFT JOIN Users u WITH (NOLOCK) ON l.UserId = u.Id
            WHERE Action IN ('CREATE', 'UPDATE', 'DELETE', 'LOGIN')
            ${orgId ? 'AND l.OrgId = ' + orgId : ''}
            ${hospId ? 'AND l.HospitalId = ' + hospId : ''}
            ORDER BY l.LogId DESC;
        `;

        const recentActivity = await AppDataSource.query(recentActivityQuery);

        // 4. Analytics (Appointments & Revenue)
        const analyticsQuery = `
            SELECT 
                -- Today's Stats (IST Adjustment)
                COUNT(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(DATEADD(MINUTE, 330, GETUTCDATE()) AS DATE) THEN 1 END) as todayTotal,
                COUNT(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(DATEADD(MINUTE, 330, GETUTCDATE()) AS DATE) AND a.Status NOT IN ('Completed', 'Cancelled') THEN 1 END) as todayPending,
                COUNT(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(DATEADD(MINUTE, 330, GETUTCDATE()) AS DATE) AND a.Status = 'Completed' THEN 1 END) as todayCompleted,
                
                -- Total Stats
                COUNT(a.Id) as totalAppointments,
                SUM(ISNULL(hp.ConsultationFee, 0)) as totalRevenue,
                
                -- Current Month Stats (Calendar Month in IST)
                COUNT(CASE WHEN MONTH(a.AppointmentDate) = MONTH(DATEADD(MINUTE, 330, GETUTCDATE())) AND YEAR(a.AppointmentDate) = YEAR(DATEADD(MINUTE, 330, GETUTCDATE())) THEN 1 END) as currentMonthAppointments,
                SUM(CASE WHEN MONTH(a.AppointmentDate) = MONTH(DATEADD(MINUTE, 330, GETUTCDATE())) AND YEAR(a.AppointmentDate) = YEAR(DATEADD(MINUTE, 330, GETUTCDATE())) AND a.Status IN ('Confirmed', 'Arrived', 'InProgress', 'Completed') THEN ISNULL(hp.ConsultationFee, 0) ELSE 0 END) as currentMonthRevenue,
                
                -- Previous Month Stats
                COUNT(CASE WHEN MONTH(a.AppointmentDate) = MONTH(DATEADD(MONTH, -1, DATEADD(MINUTE, 330, GETUTCDATE()))) AND YEAR(a.AppointmentDate) = YEAR(DATEADD(MONTH, -1, DATEADD(MINUTE, 330, GETUTCDATE()))) THEN 1 END) as prevMonthAppointments,
                SUM(CASE WHEN MONTH(a.AppointmentDate) = MONTH(DATEADD(MONTH, -1, DATEADD(MINUTE, 330, GETUTCDATE()))) AND YEAR(a.AppointmentDate) = YEAR(DATEADD(MONTH, -1, DATEADD(MINUTE, 330, GETUTCDATE()))) AND a.Status IN ('Confirmed', 'Arrived', 'InProgress', 'Completed') THEN ISNULL(hp.ConsultationFee, 0) ELSE 0 END) as prevMonthRevenue
            FROM Appointments a WITH (NOLOCK)
            LEFT JOIN HealthcareProviders hp WITH (NOLOCK) ON a.DoctorId = hp.UserId
            WHERE 1=1
            ${orgId ? 'AND a.OrgId = ' + orgId : ''}
            ${hospId ? 'AND a.HospitalId = ' + hospId : ''}
        `;

        const analyticsResults = await AppDataSource.query(analyticsQuery);
        const stats = analyticsResults[0] || {};

        // Calculate Trends/Analysis
        const calculateTrend = (current: number, previous: number) => {
            if (previous === 0) return current > 0 ? 100 : 0;
            return Math.round(((current - previous) / previous) * 100);
        };

        const revenueTrend = calculateTrend(stats.currentMonthRevenue || 0, stats.prevMonthRevenue || 0);
        const appointmentTrend = calculateTrend(stats.currentMonthAppointments || 0, stats.prevMonthAppointments || 0);

        return {
            totalUsers,
            activeUsers,
            totalAppointments: stats.totalAppointments || 0,
            totalRevenue: stats.totalRevenue || 0,
            todayAppointments: stats.todayTotal || 0,
            pendingAppointments: stats.todayPending || 0,
            completedAppointments: stats.todayCompleted || 0,
            monthlyRevenue: stats.currentMonthRevenue || 0,
            revenueChange: revenueTrend,
            revenueIncrease: (stats.currentMonthRevenue || 0) - (stats.prevMonthRevenue || 0),
            appointmentChange: appointmentTrend,
            appointmentIncrease: (stats.currentMonthAppointments || 0) - (stats.prevMonthAppointments || 0),
            roleStats,
            recentActivity
        };
    }

    async getAnalyticsStats(timeRange: string = '30d') {
        const userRepo = AppDataSource.getRepository(User);
        const orgRepo = AppDataSource.getRepository(Organization);

        let dateLimit: string;
        switch (timeRange) {
            case '7d': dateLimit = "DATEADD(DAY, -7, DATEADD(MINUTE, 330, GETUTCDATE()))"; break;
            case '90d': dateLimit = "DATEADD(DAY, -90, DATEADD(MINUTE, 330, GETUTCDATE()))"; break;
            case '1y': dateLimit = "DATEADD(YEAR, -1, DATEADD(MINUTE, 330, GETUTCDATE()))"; break;
            case 'all': dateLimit = "CAST('1970-01-01' AS DATETIME)"; break;
            default: dateLimit = "DATEADD(DAY, -30, DATEADD(MINUTE, 330, GETUTCDATE()))"; // 30d
        }

        // 1. Basic Stats (Filtered by timeRange)
        const totalUsersQuery = userRepo.createQueryBuilder("u").where("u.IsDeleted = 0");
        const activeUsersQuery = userRepo.createQueryBuilder("u").where("u.Status = 1 AND u.IsDeleted = 0");
        const totalOrgsQuery = orgRepo.createQueryBuilder("o").where("o.Status = 1");

        if (timeRange !== 'all') {
            totalUsersQuery.andWhere(`u.CreatedAt >= ${dateLimit}`);
            activeUsersQuery.andWhere(`u.CreatedAt >= ${dateLimit}`);
            totalOrgsQuery.andWhere(`o.CreatedAt >= ${dateLimit}`);
        }

        const [totalUsers, activeUsers, totalOrgs] = await Promise.all([
            totalUsersQuery.getCount(),
            activeUsersQuery.getCount(),
            totalOrgsQuery.getCount()
        ]);

        // 2. Growth Trends (Monthly in IST - fixed last 6 months for trend visualization)
        const userGrowthQuery = `
            SELECT 
                FORMAT(CreatedAt, 'MMM yyyy') as month,
                COUNT(Id) as count
            FROM Users WITH (NOLOCK)
            WHERE CreatedAt >= DATEADD(MONTH, -6, DATEADD(MINUTE, 330, GETUTCDATE()))
            GROUP BY FORMAT(CreatedAt, 'MMM yyyy'), YEAR(CreatedAt), MONTH(CreatedAt)
            ORDER BY YEAR(CreatedAt), MONTH(CreatedAt)
        `;

        const orgGrowthQuery = `
            SELECT 
                FORMAT(CreatedAt, 'MMM yyyy') as month,
                COUNT(Id) as count
            FROM Organizations WITH (NOLOCK)
            WHERE CreatedAt >= DATEADD(MONTH, -6, DATEADD(MINUTE, 330, GETUTCDATE()))
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

        // 4. Top Organizations (By Revenue - Filtered by timeRange)
        const topOrgsQuery = `
            SELECT TOP 5
                o.Name as name,
                SUM(ISNULL(hp.ConsultationFee, 0)) as revenue,
                COUNT(a.Id) as appointmentCount,
                (SELECT COUNT(DISTINCT ur.UserId) FROM UserRoles ur WITH (NOLOCK) INNER JOIN Roles r WITH (NOLOCK) ON ur.RoleId = r.Id INNER JOIN Users u WITH (NOLOCK) ON ur.UserId = u.Id WHERE ur.OrganizationId = o.Id AND r.RoleName != 'Patient' AND ur.IsDeleted = 0 AND ur.Status = 1 AND u.Status = 1 AND u.IsDeleted = 0) as staffCount,
                (SELECT COUNT(DISTINCT ur.UserId) FROM UserRoles ur WITH (NOLOCK) INNER JOIN Roles r WITH (NOLOCK) ON ur.RoleId = r.Id INNER JOIN Users u WITH (NOLOCK) ON ur.UserId = u.Id WHERE ur.OrganizationId = o.Id AND r.RoleName = 'Patient' AND ur.IsDeleted = 0 AND ur.Status = 1 AND u.Status = 1 AND u.IsDeleted = 0) as patientCount,
                CAST(CASE 
                    WHEN SUM(CASE WHEN MONTH(a.AppointmentDate) = MONTH(DATEADD(MONTH, -1, DATEADD(MINUTE, 330, GETUTCDATE()))) AND YEAR(a.AppointmentDate) = YEAR(DATEADD(MONTH, -1, DATEADD(MINUTE, 330, GETUTCDATE()))) THEN ISNULL(hp.ConsultationFee, 0) ELSE 0 END) = 0 
                    THEN CASE WHEN SUM(CASE WHEN MONTH(a.AppointmentDate) = MONTH(DATEADD(MINUTE, 330, GETUTCDATE())) AND YEAR(a.AppointmentDate) = YEAR(DATEADD(MINUTE, 330, GETUTCDATE())) THEN ISNULL(hp.ConsultationFee, 0) ELSE 0 END) > 0 THEN 100 ELSE 0 END
                    ELSE 
                        ((SUM(CASE WHEN MONTH(a.AppointmentDate) = MONTH(DATEADD(MINUTE, 330, GETUTCDATE())) AND YEAR(a.AppointmentDate) = YEAR(DATEADD(MINUTE, 330, GETUTCDATE())) THEN ISNULL(hp.ConsultationFee, 0) ELSE 0 END) - 
                          SUM(CASE WHEN MONTH(a.AppointmentDate) = MONTH(DATEADD(MONTH, -1, DATEADD(MINUTE, 330, GETUTCDATE()))) AND YEAR(a.AppointmentDate) = YEAR(DATEADD(MONTH, -1, DATEADD(MINUTE, 330, GETUTCDATE()))) THEN ISNULL(hp.ConsultationFee, 0) ELSE 0 END)) / 
                          SUM(CASE WHEN MONTH(a.AppointmentDate) = MONTH(DATEADD(MONTH, -1, DATEADD(MINUTE, 330, GETUTCDATE()))) AND YEAR(a.AppointmentDate) = YEAR(DATEADD(MONTH, -1, DATEADD(MINUTE, 330, GETUTCDATE()))) THEN ISNULL(hp.ConsultationFee, 0) ELSE 0 END)) * 100
                END AS DECIMAL(10,1)) as growth
            FROM Organizations o WITH (NOLOCK)
            LEFT JOIN Appointments a WITH (NOLOCK) ON o.Id = a.OrgId ${timeRange !== 'all' ? `AND a.AppointmentDate >= ${dateLimit}` : ''}
            LEFT JOIN HealthcareProviders hp WITH (NOLOCK) ON a.DoctorId = hp.UserId
            GROUP BY o.Id, o.Name
            ORDER BY revenue DESC
        `;
        const topOrgs = await AppDataSource.query(topOrgsQuery);

        // 5. Global Analytics (Appointments & Revenue - Filtered by timeRange)
        const globalAnalyticsQuery = `
            SELECT 
                COUNT(a.Id) as totalAppointments,
                SUM(ISNULL(hp.ConsultationFee, 0)) as totalRevenue
            FROM Appointments a WITH (NOLOCK)
            LEFT JOIN HealthcareProviders hp WITH (NOLOCK) ON a.DoctorId = hp.UserId
            ${timeRange !== 'all' ? `WHERE a.AppointmentDate >= ${dateLimit}` : ''}
        `;
        const globalStats = await AppDataSource.query(globalAnalyticsQuery);

        return {
            totalUsers,
            activeUsers,
            totalOrganizations: totalOrgs,
            totalAppointments: globalStats[0]?.totalAppointments || 0,
            totalRevenue: globalStats[0]?.totalRevenue || 0,
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
            .where("user.IsDeleted = 0 AND user.Status = 1")
            .andWhere("ur.IsDeleted = 0 AND ur.Status = 1");

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

        // 3. Paginated Data with per-organization counts
        const skip = (page - 1) * pageSize;
        const orgsQuery = orgRepo.createQueryBuilder("org")
            .select([
                "org.Id", "org.Name", "org.OrgCode", "org.OrganizationType",
                "org.Email", "org.MobileNumber", "org.CountryCode",
                "org.Address", "org.Status", "org.CreatedAt", "org.Website"
            ])
            .addSelect(subQuery => {
                return subQuery
                    .select("COUNT(DISTINCT ur1.UserId)", "staffCount")
                    .from(UserRole, "ur1")
                    .innerJoin(Role, "r1", "ur1.RoleId = r1.Id")
                    .where("ur1.OrganizationId = org.Id")
                    .andWhere("r1.RoleName != :patientRole", { patientRole: "Patient" })
                    .andWhere("ur1.IsDeleted = 0")
                    .andWhere("ur1.Status = 1");
            }, "UserCount")
            .addSelect(subQuery => {
                return subQuery
                    .select("COUNT(DISTINCT ur2.UserId)", "patientCount")
                    .from(UserRole, "ur2")
                    .innerJoin(Role, "r2", "ur2.RoleId = r2.Id")
                    .where("ur2.OrganizationId = org.Id")
                    .andWhere("r2.RoleName = :patientRole", { patientRole: "Patient" })
                    .andWhere("ur2.IsDeleted = 0")
                    .andWhere("ur2.Status = 1");
            }, "PatientCount");

        // Apply same filters as query
        if (orgId) orgsQuery.andWhere("org.Id = :orgId", { orgId });
        if (type && type !== "all" && type !== "ANY") orgsQuery.andWhere("org.OrganizationType = :type", { type });
        if (search) {
            orgsQuery.andWhere("(org.Name LIKE :search OR org.OrgCode LIKE :search)", { search: `%${search}%` });
        }

        const rawOrgs = await orgsQuery
            .orderBy("org.CreatedAt", "DESC")
            .skip(skip)
            .take(pageSize)
            .getRawMany();

        const organizations = rawOrgs.map(org => ({
            Id: org.org_Id,
            Name: org.org_Name,
            OrgCode: org.org_OrgCode,
            OrganizationType: org.org_OrganizationType,
            Email: org.org_Email,
            MobileNumber: org.org_MobileNumber,
            CountryCode: org.org_CountryCode,
            Address: org.org_Address,
            Status: org.org_Status,
            CreatedAt: org.org_CreatedAt,
            Website: org.org_Website,
            UserCount: parseInt(org.UserCount || "0"),
            PatientCount: parseInt(org.PatientCount || "0")
        }));

        return {
            totalOrganizations,
            activeOrganizations,
            totalUsers: parseInt(totalUsers.count || "0"),
            totalPatients: parseInt(totalPatients.count || "0"),
            pagination: {
                page,
                pageSize,
                totalRecords: totalOrganizations,
                totalPages: Math.ceil(totalOrganizations / pageSize)
            },
            organizationStats: organizations
        };
    }
    async getFrontdeskDashboardStats(hospId: number) {
        // 1. Fetch Today's and Yesterday's Stats for Trends
        const statsQuery = `
            SELECT 
                -- Today's Metrics (IST)
                COUNT(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(DATEADD(MINUTE, 330, GETUTCDATE()) AS DATE) THEN 1 END) as todayCheckIns,
                COUNT(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(DATEADD(MINUTE, 330, GETUTCDATE()) AS DATE) THEN 1 END) as todayScheduled,
                COUNT(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(DATEADD(MINUTE, 330, GETUTCDATE()) AS DATE) AND q.Status = 'Waiting' THEN 1 END) as todayWaiting,
                ISNULL(SUM(CASE WHEN CAST(p.TransactionDate AS DATE) = CAST(DATEADD(MINUTE, 330, GETUTCDATE()) AS DATE) AND p.Status = 'Success' THEN p.Amount ELSE 0 END), 0) as todayPayments,
                
                -- Yesterday's Metrics (IST)
                COUNT(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(DATEADD(day, -1, DATEADD(MINUTE, 330, GETUTCDATE())) AS DATE) AND a.Status = 'Arrived' THEN 1 END) as yesterdayCheckIns,
                COUNT(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(DATEADD(day, -1, DATEADD(MINUTE, 330, GETUTCDATE())) AS DATE) THEN 1 END) as yesterdayScheduled,
                COUNT(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(DATEADD(day, -1, DATEADD(MINUTE, 330, GETUTCDATE())) AS DATE) AND q.Status = 'Waiting' THEN 1 END) as yesterdayWaiting,
                ISNULL(SUM(CASE WHEN CAST(p.TransactionDate AS DATE) = CAST(DATEADD(day, -1, DATEADD(MINUTE, 330, GETUTCDATE())) AS DATE) AND p.Status = 'Success' THEN p.Amount ELSE 0 END), 0) as yesterdayPayments
            FROM Appointments a WITH (NOLOCK)
            LEFT JOIN Payments p WITH (NOLOCK) ON a.Id = p.AppointmentId AND p.IsDeleted = 0
            LEFT JOIN PatientQueue q WITH (NOLOCK) ON a.Id = q.AppointmentId
            WHERE a.HospitalId = ${hospId} 
            AND a.AppointmentDate >= CAST(DATEADD(day, -1, DATEADD(MINUTE, 330, GETUTCDATE())) AS DATE)
            AND a.AppointmentDate <= CAST(DATEADD(MINUTE, 330, GETUTCDATE()) AS DATE);
        `;

        // 2. Fetch Recent Activity for the Hospital
        const recentActivityQuery = `
            SELECT TOP 10
                CASE 
                    WHEN Action = 'LOGIN' THEN 'User Logged In'
                    WHEN EntityType = 'patients' AND Action = 'CREATE' THEN 'New Patient Registered'
                    WHEN EntityType = 'appointments' AND Action = 'CREATE' THEN 'New Appointment Scheduled'
                    WHEN EntityType = 'appointments' AND Action = 'UPDATE' THEN 'Appointment Status Updated'
                    WHEN EntityType = 'auth' AND Action = 'CREATE' THEN 'User Authenticated'
                    ELSE 
                        CASE 
                            WHEN EntityType IS NULL THEN 'System Activity'
                            ELSE UPPER(LEFT(EntityType, 1)) + SUBSTRING(EntityType, 2, 100)
                        END + ' ' + 
                        CASE 
                            WHEN Action = 'CREATE' THEN 'Created'
                            WHEN Action = 'UPDATE' THEN 'Updated'
                            WHEN Action = 'DELETE' THEN 'Deleted'
                            ELSE ISNULL(Action, 'Activity')
                        END
                END AS ActivityMessage,
                LogId as id,
                UpdatedOn as timestamp,
                ISNULL(NULLIF(LTRIM(RTRIM(ISNULL(u.FirstName, '') + ' ' + ISNULL(u.LastName, ''))), ''), 'System') as [user],
                l.RoleName as role
            FROM APILogs l WITH (NOLOCK)
            LEFT JOIN Users u WITH (NOLOCK) ON l.UserId = u.Id
            WHERE l.HospitalId = ${hospId}
            AND Action IN ('CREATE', 'UPDATE', 'DELETE', 'LOGIN')
            ORDER BY LogId DESC;
        `;

        // 3. Recent Patients (Limit 6)
        const recentPatientsQuery = `
            SELECT TOP 6
                a.UserId as id,
                u.FirstName + ' ' + u.LastName as name,
                u.Gender as gender,
                DATEDIFF(YEAR, u.DateOfBirth, GETDATE()) as age,
                a.AppointmentDate as lastVisit,
                a.Reason as condition,
                a.Status as status
            FROM Appointments a WITH (NOLOCK)
            INNER JOIN Users u WITH (NOLOCK) ON a.UserId = u.Id
            WHERE a.HospitalId = ${hospId}
            AND a.Status = 'Completed'
            ORDER BY a.AppointmentDate DESC, a.StartTime DESC;
        `;

        // 4. Weekly Stats (Last 7 days)
        const weeklyStatsQuery = `
            SELECT 
                FORMAT(AppointmentDate, 'ddd') as day,
                COUNT(*) as appointments,
                COUNT(DISTINCT UserId) as patients
            FROM Appointments WITH (NOLOCK)
            WHERE HospitalId = ${hospId}
            AND AppointmentDate >= DATEADD(day, -6, GETDATE())
            GROUP BY FORMAT(AppointmentDate, 'ddd'), CAST(AppointmentDate AS DATE)
            ORDER BY CAST(AppointmentDate AS DATE) ASC;
        `;

        // 5. Monthly Stats (Last 6 months)
        const monthlyStatsQuery = `
            SELECT 
                FORMAT(AppointmentDate, 'MMM') as month,
                COUNT(*) as appointments,
                COUNT(DISTINCT UserId) as patients
            FROM Appointments WITH (NOLOCK)
            WHERE HospitalId = ${hospId}
            AND AppointmentDate >= DATEADD(month, -5, GETDATE())
            GROUP BY FORMAT(AppointmentDate, 'MMM'), YEAR(AppointmentDate), MONTH(AppointmentDate)
            ORDER BY YEAR(AppointmentDate), MONTH(AppointmentDate) ASC;
        `;

        const [statsResults, recentActivity, recentPatients, weeklyStats, monthlyStats] = await Promise.all([
            AppDataSource.query(statsQuery),
            AppDataSource.query(recentActivityQuery),
            AppDataSource.query(recentPatientsQuery),
            AppDataSource.query(weeklyStatsQuery),
            AppDataSource.query(monthlyStatsQuery)
        ]);

        const statsRow = statsResults[0] || {};

        return {
            stats: {
                todayCheckIns: statsRow.todayCheckIns || 0,
                appointmentsScheduled: statsRow.todayScheduled || 0,
                waitingPatients: statsRow.todayWaiting || 0,
                paymentsCollected: statsRow.todayPayments || 0,

                // Yesterday values for trend calculation in service
                yesterdayCheckIns: statsRow.yesterdayCheckIns || 0,
                yesterdayScheduled: statsRow.yesterdayScheduled || 0,
                yesterdayWaiting: statsRow.yesterdayWaiting || 0,
                yesterdayPayments: statsRow.yesterdayPayments || 0
            },
            recentActivity: recentActivity.map((a: any) => ({
                id: a.id,
                title: a.ActivityMessage,
                description: `Performed by ${a.user} (${a.role})`,
                time: a.timestamp,
                type: "success",
                iconType: a.ActivityMessage.includes("Check") ? "UserCheck" :
                    a.ActivityMessage.includes("Appointment") ? "Calendar" :
                        a.ActivityMessage.includes("Patient") ? "UserPlus" : "Activity"
            })),
            recentPatients: recentPatients.map((p: any) => ({
                id: p.id,
                name: p.name,
                gender: p.gender,
                age: p.age,
                lastVisit: p.lastVisit,
                condition: p.condition,
                status: p.status?.toLowerCase()
            })),
            weeklyStats,
            monthlyStats
        };
    }

    async getDoctorDashboardStats(doctorId: string, hospId: number) {
        const statsQuery = `
            SELECT 
                -- Today's Appointments
                COUNT(*) as totalToday,
                COUNT(CASE WHEN Status = 'Completed' THEN 1 END) as completedToday,
                COUNT(CASE WHEN Status IN ('Confirmed', 'Arrived', 'Scheduled', 'InProgress') THEN 1 END) as pendingToday,
                
                -- Patients Seen Today (distinct completed appointments)
                COUNT(DISTINCT CASE WHEN Status = 'Completed' THEN UserId END) as patientsSeenToday,
                
                -- Follow-ups vs New Patients Today
                COUNT(CASE WHEN AppointmentType = 'Follow-up' THEN 1 END) as followUpsToday,
                COUNT(CASE WHEN AppointmentType IN ('New', 'Consultation', 'New Patient') THEN 1 END) as newPatientsToday
            FROM Appointments WITH (NOLOCK)
            WHERE DoctorId = '${doctorId}' AND HospitalId = ${hospId}
            AND CAST(AppointmentDate AS DATE) = CAST(DATEADD(MINUTE, 330, GETUTCDATE()) AS DATE);
        `;

        const patientStatsQuery = `
            SELECT 
                -- Total Patients for this doctor
                (SELECT COUNT(DISTINCT UserId) FROM Appointments WITH (NOLOCK) WHERE DoctorId = '${doctorId}' AND HospitalId = ${hospId}) as totalPatients,
                
                -- New this week (Patients whose FIRST appointment with this doctor is this week in IST)
                (SELECT COUNT(DISTINCT a1.UserId) 
                 FROM Appointments a1 WITH (NOLOCK)
                 WHERE a1.DoctorId = '${doctorId}' 
                 AND a1.HospitalId = ${hospId}
                 AND a1.AppointmentDate >= DATEADD(day, -DATEPART(weekday, DATEADD(MINUTE, 330, GETUTCDATE())) + 1, DATEADD(MINUTE, 330, GETUTCDATE()))
                 AND NOT EXISTS (
                     SELECT 1 FROM Appointments a2 WITH (NOLOCK)
                     WHERE a2.UserId = a1.UserId 
                     AND a2.DoctorId = a1.DoctorId 
                     AND a2.AppointmentDate < DATEADD(day, -DATEPART(weekday, DATEADD(MINUTE, 330, GETUTCDATE())) + 1, DATEADD(MINUTE, 330, GETUTCDATE()))
                 )) as newPatientsThisWeek;
        `;

        // 3. Recent Patients for this Doctor (Limit 6)
        const recentPatientsQuery = `
            SELECT TOP 6
                a.UserId as id,
                u.FirstName + ' ' + u.LastName as name,
                u.Gender as gender,
                DATEDIFF(YEAR, u.DateOfBirth, GETDATE()) as age,
                a.AppointmentDate as lastVisit,
                a.Reason as condition,
                a.Status as status
            FROM Appointments a WITH (NOLOCK)
            INNER JOIN Users u WITH (NOLOCK) ON a.UserId = u.Id
            WHERE a.DoctorId = '${doctorId}' AND a.HospitalId = ${hospId}
            AND a.Status = 'Completed'
            ORDER BY a.AppointmentDate DESC, a.StartTime DESC;
        `;

        console.log(`Fetching Doctor Dashboard stats for Doctor: ${doctorId}, Hospital: ${hospId}`);

        const [statsResults, patientResults, recentPatientsResult, weeklyStats, monthlyStats] = await Promise.all([
            AppDataSource.query(statsQuery),
            AppDataSource.query(patientStatsQuery),
            AppDataSource.query(recentPatientsQuery),
            AppDataSource.query(`
                SELECT 
                    FORMAT(AppointmentDate, 'ddd') as day,
                    COUNT(*) as appointments,
                    COUNT(DISTINCT UserId) as patients
                FROM Appointments WITH (NOLOCK)
                WHERE DoctorId = '${doctorId}' AND HospitalId = ${hospId}
                AND AppointmentDate >= CAST(DATEADD(day, -6, DATEADD(MINUTE, 330, GETUTCDATE())) AS DATE)
                GROUP BY FORMAT(AppointmentDate, 'ddd'), CAST(AppointmentDate AS DATE)
                ORDER BY CAST(AppointmentDate AS DATE) ASC;
            `),
            AppDataSource.query(`
                SELECT 
                    FORMAT(AppointmentDate, 'MMM') as month,
                    COUNT(*) as appointments,
                    COUNT(DISTINCT UserId) as patients
                FROM Appointments WITH (NOLOCK)
                WHERE DoctorId = '${doctorId}' AND HospitalId = ${hospId}
                AND AppointmentDate >= CAST(DATEADD(month, -5, DATEADD(MINUTE, 330, GETUTCDATE())) AS DATE)
                GROUP BY FORMAT(AppointmentDate, 'MMM'), YEAR(AppointmentDate), MONTH(AppointmentDate)
                ORDER BY YEAR(AppointmentDate), MONTH(AppointmentDate) ASC;
            `)
        ]);

        console.log(`Doctor Dashboard Data: Stats Found: ${statsResults.length}, Weekly Stats Found: ${weeklyStats.length}, Monthly Stats Found: ${monthlyStats.length}`);

        const stats = statsResults[0] || {};
        const patientStats = patientResults[0] || {};

        console.log(`Doctor Dashboard Data: Today Total: ${stats.totalToday || 0}, Total Patients: ${patientStats.totalPatients || 0}, Weekly Rows: ${weeklyStats.length}, Monthly Rows: ${monthlyStats.length}`);

        return {
            todayStats: {
                totalAppointments: stats.totalToday || 0,
                completedAppointments: stats.completedToday || 0,
                pendingAppointments: stats.pendingToday || 0,
                patientsSeenToday: stats.patientsSeenToday || 0,
                followUps: stats.followUpsToday || 0,
                newPatients: stats.newPatientsToday || 0
            },
            totalPatients: patientStats.totalPatients || 0,
            newPatientsThisWeek: patientStats.newPatientsThisWeek || 0,
            recentPatients: recentPatientsResult.map((p: any) => ({
                id: p.id,
                name: p.name,
                gender: p.gender,
                age: p.age,
                lastVisit: p.lastVisit,
                condition: p.condition,
                status: p.status?.toLowerCase()
            })),
            weeklyStats,
            monthlyStats
        };
    }
}

export const dashboardRepository = new DashboardRepository();
