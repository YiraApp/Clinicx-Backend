import { AppDataSource } from "../../config/database.js";
import { Appointment } from "../../models/Appointments/appointment.model.js";
import { AppointmentStatus } from "../../enums/appointments.js";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import { PatientInsurance } from "../../models/Organizations/patient-insurance.model.js";

const PATIENT_ROLE_ID = "4FC67429-28AE-4106-93EF-436228282ED0";
const PATIENT_ROLE_JOIN = "ur.IsDeleted = 0 AND ur.Status = 1 AND ur.RoleId = :patientRoleId AND ur.OrganizationId = pr.OrganizationId";

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

    /** The joins and filters that the patient list, its paging and its counts share. */
    private filtered(filters: any) {
        const query = this.repo.createQueryBuilder("pr")
            .innerJoin("pr.User", "u")
            .innerJoin("u.UserRoles", "ur", PATIENT_ROLE_JOIN, { patientRoleId: PATIENT_ROLE_ID })
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
                "(u.FirstName LIKE :search OR u.LastName LIKE :search OR (u.FirstName + ' ' + u.LastName) LIKE :search OR u.PhoneNumber LIKE :search OR u.Email LIKE :search OR CAST(pr.Id AS NVARCHAR(MAX)) LIKE :search OR CAST(u.Id AS NVARCHAR(MAX)) LIKE :search OR u.TokenNumber LIKE :search OR pr.TokenNumber LIKE :search)",
                { search: `%${filters.search}%` }
            );
        }
        if (filters.tokenNumber || filters.token) {
            const tokenVal = (filters.tokenNumber || filters.token).trim();
            query.andWhere("(u.TokenNumber LIKE :tokenFilter OR pr.TokenNumber LIKE :tokenFilter)", { tokenFilter: `%${tokenVal}%` });
        }
        if (filters.doctorId) {
            // Patients who have booked with this doctor. An IN list of the doctor's patients is
            // cheaper than checking Appointments once per registration.
            query.andWhere(
                `pr.UserId IN (SELECT a.UserId FROM Appointments a WHERE a.DoctorId = :doctorId AND a.UserId IS NOT NULL)`,
                { doctorId: filters.doctorId }
            );
        }
        return query;
    }

    /** Runs a query with a plan compiled for these values, so a bad cached plan can't be reused. */
    private async runFresh(query: any): Promise<any[]> {
        const [sql, params] = query.getQueryAndParameters();
        return AppDataSource.query(`${sql} OPTION (RECOMPILE)`, params);
    }

    async getPatients(page: number = 1, pageSize: number = 10, filters: any): Promise<any> {
        const skip = (page - 1) * pageSize;

        // Paging a query that joins collections makes TypeORM wrap everything in one big DISTINCT
        // subquery, and SQL Server cached a plan for it that took over a minute for one doctor
        // (the same query compiled fresh takes about a second). So the page of ids comes from a
        // lean query compiled fresh each time, and only those registrations are loaded in full.
        const pageRows = await this.runFresh(
            this.filtered(filters)
                .select("pr.Id", "id")
                .addSelect("pr.CreatedAt", "createdAt")
                .distinct(true)
                .orderBy("pr.CreatedAt", "DESC")
                .addOrderBy("pr.Id", "ASC")
                .offset(skip)
                .limit(pageSize)
        );
        const [countRow] = await this.runFresh(this.filtered(filters).select("COUNT(DISTINCT pr.Id)", "total"));
        const total = parseInt(countRow?.total, 10) || 0;

        const pageIds: number[] = pageRows.map((r: any) => Number(r.id));
        const registrations = pageIds.length
            ? await this.repo.createQueryBuilder("pr")
                .innerJoinAndSelect("pr.User", "u")
                .innerJoinAndSelect("u.UserRoles", "ur", PATIENT_ROLE_JOIN, { patientRoleId: PATIENT_ROLE_ID })
                .leftJoinAndSelect("ur.Organization", "urOrg")
                .leftJoinAndSelect("ur.Hospital", "urHosp")
                .leftJoinAndSelect("u.PermanentAddress", "pa")
                .leftJoinAndSelect("pr.Organization", "org")
                .leftJoinAndSelect("pr.Hospital", "h")
                .where("pr.Id IN (:...pageIds)", { pageIds })
                .getMany()
            : [];
        const position = new Map(pageIds.map((id, n) => [id, n]));
        registrations.sort((a, b) => (position.get(Number(a.Id)) ?? 0) - (position.get(Number(b.Id)) ?? 0));

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

        // Batch-load total and completed appointment counts for each patient in the current org/hospital context
        const totalVisitsMap = new Map<string, number>();
        const completedVisitsMap = new Map<string, number>();
        if (userIds.length > 0) {
            const appointmentQuery = AppDataSource.getRepository(Appointment)
                .createQueryBuilder("a")
                .select("UPPER(a.UserId)", "userId")
                .addSelect("COUNT(*)", "totalVisits")
                .addSelect("SUM(CASE WHEN LOWER(a.Status) = LOWER(:completedStatus) THEN 1 ELSE 0 END)", "completedVisits")
                .where("a.UserId IN (:...userIds)", { userIds });

            if (filters.organizationId) {
                appointmentQuery.andWhere("a.OrgId = :orgId", { orgId: filters.organizationId });
            }
            if (filters.hospitalId) {
                appointmentQuery.andWhere("a.HospitalId = :hospId", { hospId: filters.hospitalId });
            }

            const appointmentsRaw = await appointmentQuery
                .setParameter("completedStatus", AppointmentStatus.Completed)
                .groupBy("UPPER(a.UserId)")
                .getRawMany();
            appointmentsRaw.forEach((row: any) => {
                const key = (row.userId || "").toUpperCase();
                totalVisitsMap.set(key, parseInt(row.totalVisits, 10) || 0);
                completedVisitsMap.set(key, parseInt(row.completedVisits, 10) || 0);
            });
        }

        // Batch-load next future appointment for each patient
        const nextAppointmentMap = new Map<string, string | null>();
        if (userIds.length > 0) {
            const nextAptQuery = AppDataSource.getRepository(Appointment)
                .createQueryBuilder("a")
                .select("UPPER(a.UserId)", "userId")
                .addSelect("MIN(a.AppointmentDate)", "nextDate")
                .where("a.UserId IN (:...userIds)", { userIds })
                .andWhere("a.AppointmentDate >= CAST(GETDATE() AS DATE)")
                .andWhere("LOWER(a.Status) NOT IN (:...cancelledStatuses)", { cancelledStatuses: ["cancelled", "noshow", "completed"] });

            if (filters.organizationId) {
                nextAptQuery.andWhere("a.OrgId = :orgId", { orgId: filters.organizationId });
            }
            if (filters.hospitalId) {
                nextAptQuery.andWhere("a.HospitalId = :hospId", { hospId: filters.hospitalId });
            }

            const nextAptRaw = await nextAptQuery
                .groupBy("UPPER(a.UserId)")
                .getRawMany();
            nextAptRaw.forEach((row: any) => {
                const key = (row.userId || "").toUpperCase();
                nextAppointmentMap.set(key, row.nextDate || null);
            });
        }

        // Summary stats for this org/hosp context
        const [stats] = await this.runFresh(
            this.filtered(filters)
                .select("COUNT(pr.Id)", "total")
                .addSelect("SUM(CASE WHEN u.Status = 1 THEN 1 ELSE 0 END)", "active")
        );


        const patients = registrations.map(pr => {
            const ins = insuranceMap.get(pr.UserId.toUpperCase());
            const userIdKey = pr.UserId.toUpperCase();
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
                tokenNumber: pr.TokenNumber || pr.User?.TokenNumber || null,
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
                totalVisits: totalVisitsMap.get(userIdKey) || 0,
                completedVisits: completedVisitsMap.get(userIdKey) || 0,
                nextAppointment: nextAppointmentMap.get(userIdKey) || null,
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
