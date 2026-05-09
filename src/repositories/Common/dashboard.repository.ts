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
    async getFrontdeskDashboardStats(hospId: number) {
        // 1. Fetch Today's and Yesterday's Stats for Trends
        const statsQuery = `
            SELECT 
                -- Today's Metrics
                COUNT(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(GETDATE() AS DATE) AND a.Status = 'Arrived' THEN 1 END) as todayCheckIns,
                COUNT(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(GETDATE() AS DATE) THEN 1 END) as todayScheduled,
                COUNT(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(GETDATE() AS DATE) AND q.Status = 'Waiting' THEN 1 END) as todayWaiting,
                SUM(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(GETDATE() AS DATE) AND a.Status IN ('Confirmed', 'Arrived', 'InProgress', 'Completed') THEN ISNULL(hp.ConsultationFee, 0) ELSE 0 END) as todayPayments,
                
                -- Yesterday's Metrics (for Trends)
                COUNT(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(DATEADD(day, -1, GETDATE()) AS DATE) AND a.Status = 'Arrived' THEN 1 END) as yesterdayCheckIns,
                COUNT(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(DATEADD(day, -1, GETDATE()) AS DATE) THEN 1 END) as yesterdayScheduled,
                COUNT(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(DATEADD(day, -1, GETDATE()) AS DATE) AND q.Status = 'Waiting' THEN 1 END) as yesterdayWaiting,
                SUM(CASE WHEN CAST(a.AppointmentDate AS DATE) = CAST(DATEADD(day, -1, GETDATE()) AS DATE) AND a.Status IN ('Confirmed', 'Arrived', 'InProgress', 'Completed') THEN ISNULL(hp.ConsultationFee, 0) ELSE 0 END) as yesterdayPayments
            FROM Appointments a
            LEFT JOIN HealthcareProviders hp ON a.DoctorId = hp.UserId
            LEFT JOIN PatientQueue q ON a.Id = q.AppointmentId
            WHERE a.HospitalId = ${hospId} 
            AND a.AppointmentDate >= CAST(DATEADD(day, -1, GETDATE()) AS DATE)
            AND a.AppointmentDate <= CAST(GETDATE() AS DATE);
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
            FROM APILogs l
            LEFT JOIN Users u ON l.UserId = u.Id
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
            FROM Appointments a
            INNER JOIN Users u ON a.UserId = u.Id
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
            FROM Appointments
            WHERE HospitalId = ${hospId}
            AND AppointmentDate >= DATEADD(day, -6, GETDATE())
            GROUP BY FORMAT(AppointmentDate, 'ddd'), AppointmentDate
            ORDER BY AppointmentDate ASC;
        `;

        // 5. Monthly Stats (Last 6 months)
        const monthlyStatsQuery = `
            SELECT 
                FORMAT(AppointmentDate, 'MMM') as month,
                COUNT(*) as appointments,
                COUNT(DISTINCT UserId) as patients
            FROM Appointments
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
            FROM Appointments
            WHERE DoctorId = '${doctorId}' AND HospitalId = ${hospId}
            AND CAST(AppointmentDate AS DATE) = CAST(GETDATE() AS DATE);
        `;

        const patientStatsQuery = `
            SELECT 
                -- Total Patients for this doctor
                (SELECT COUNT(DISTINCT UserId) FROM Appointments WHERE DoctorId = '${doctorId}' AND HospitalId = ${hospId}) as totalPatients,
                
                -- New this week (Patients whose FIRST appointment with this doctor is this week)
                (SELECT COUNT(DISTINCT a1.UserId) 
                 FROM Appointments a1 
                 WHERE a1.DoctorId = '${doctorId}' 
                 AND a1.HospitalId = ${hospId}
                 AND a1.AppointmentDate >= DATEADD(day, -DATEPART(weekday, GETDATE()) + 1, GETDATE())
                 AND NOT EXISTS (
                     SELECT 1 FROM Appointments a2 
                     WHERE a2.UserId = a1.UserId 
                     AND a2.DoctorId = a1.DoctorId 
                     AND a2.AppointmentDate < DATEADD(day, -DATEPART(weekday, GETDATE()) + 1, GETDATE())
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
            FROM Appointments a
            INNER JOIN Users u ON a.UserId = u.Id
            WHERE a.DoctorId = '${doctorId}' AND a.HospitalId = ${hospId}
            AND a.Status = 'Completed'
            ORDER BY a.AppointmentDate DESC, a.StartTime DESC;
        `;

        // 4. Weekly Stats for Doctor (Last 7 days)
        const weeklyStatsQuery = `
            SELECT 
                FORMAT(AppointmentDate, 'ddd') as day,
                COUNT(*) as appointments,
                COUNT(DISTINCT UserId) as patients
            FROM Appointments
            WHERE DoctorId = '${doctorId}' AND HospitalId = ${hospId}
            AND AppointmentDate >= DATEADD(day, -6, GETDATE())
            GROUP BY FORMAT(AppointmentDate, 'ddd'), AppointmentDate
            ORDER BY AppointmentDate ASC;
        `;

        // 5. Monthly Stats for Doctor (Last 6 months)
        const monthlyStatsQuery = `
            SELECT 
                FORMAT(AppointmentDate, 'MMM') as month,
                COUNT(*) as appointments,
                COUNT(DISTINCT UserId) as patients
            FROM Appointments
            WHERE DoctorId = '${doctorId}' AND HospitalId = ${hospId}
            AND AppointmentDate >= DATEADD(month, -5, GETDATE())
            GROUP BY FORMAT(AppointmentDate, 'MMM'), YEAR(AppointmentDate), MONTH(AppointmentDate)
            ORDER BY YEAR(AppointmentDate), MONTH(AppointmentDate) ASC;
        `;

        const [statsResults, patientResults, recentPatientsResult, weeklyStats, monthlyStats] = await Promise.all([
            AppDataSource.query(statsQuery),
            AppDataSource.query(patientStatsQuery),
            AppDataSource.query(recentPatientsQuery),
            AppDataSource.query(weeklyStatsQuery),
            AppDataSource.query(monthlyStatsQuery)
        ]);

        const stats = statsResults[0] || {};
        const patientStats = patientResults[0] || {};

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
