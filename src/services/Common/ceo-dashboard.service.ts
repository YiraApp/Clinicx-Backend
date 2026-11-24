import { MssqlParameter } from "typeorm/index.js";
import { AppDataSource } from "../../config/database.js";
import {
    AGE_BANDS,
    GENDERS,
    containsPattern,
    dashboardRange,
    statusLabel,
    type CeoDashboardFilters,
    type DashboardRange,
    type Granularity,
} from "./ceo-dashboard.filters.js";

/**
 * CEO dashboard for Yira System Admin: onboarding, roles, providers, appointments and diagnoses
 * across the platform. Every number is aggregated in SQL; only summary rows reach Node.
 *
 * Definitions (also shown on the page under "How these are counted"):
 * - Onboarded: a UserRoles row (not soft-deleted). A user's onboarding date for a role is their
 *   earliest in-scope UserRoles.CreatedAt for it, so a hospital filter means "onboarded there".
 * - Active: the grant (UserRoles.Status) and the user (Users.Status) are both active.
 * - Diagnoses: doctor-recorded ones from PrescriptionDiagnosis, PatientMedicalRecord.Diagnosis
 *   (comma separated; vitals records excluded) and DischargeSummaries.Diagnoses (JSON).
 * - Location filters match the hospital's address; few users have an address of their own.
 *
 * Each query's SQL text is the same whatever the filters: every filter is always passed, typed,
 * and tested with `@p IS NULL OR ...`. SQL Server then compiles each query once and reuses the
 * plan; with filter-shaped SQL every new combination cost seconds of compiling on the dev tier.
 */

const TODAY_IN_INDIA = "CAST(DATEADD(MINUTE, 330, GETUTCDATE()) AS date)";
const MAX_LENGTH = 65535; // node-mssql's MAX: declares nvarchar(max)

/** Placeholders, fixed for every query (unused ones are harmless). */
const P = {
    from: "CAST(@0 AS date)",
    /** The day after the period ends: compare with `<` so the last day counts in full. */
    toExclusive: "DATEADD(DAY, 1, CAST(@1 AS date))",
    previousFrom: "CAST(@2 AS date)",
    organizationId: "@3",
    hospitalId: "@4",
    gender: "@5",
    ageBand: "@6",
    state: "@7",
    city: "@8",
    pincode: "@9",
    specialty: "@10",
    /** JSON array of role ids, or NULL for every role. */
    roleIds: "@11",
    /** JSON array of the patients matching the disease filter, or NULL when there is none. */
    diseasePatients: "@12",
    diseaseLike: "@13",
    diseaseExact: "@14",
} as const;

const jsonIds = (param: string, alias: string) => `SELECT ${alias}.Id FROM OPENJSON(${param}) WITH (Id uniqueidentifier '$') ${alias}`;

const inPeriod = (column: string) => `(${column} >= ${P.from} AND ${column} < ${P.toExclusive})`;
const inPreviousPeriod = (column: string) => `(${column} >= ${P.previousFrom} AND ${column} < ${P.from})`;

/** Gender and age band of the user aliased `u`, as `${alias}.Gender` / `${alias}.AgeBand`. */
const person = (u: string, alias: string) => `
    CROSS APPLY (SELECT
        CASE WHEN ${u}.DateOfBirth IS NULL THEN NULL
             ELSE DATEDIFF(YEAR, ${u}.DateOfBirth, ${TODAY_IN_INDIA})
                  - CASE WHEN DATEADD(YEAR, DATEDIFF(YEAR, ${u}.DateOfBirth, ${TODAY_IN_INDIA}), ${u}.DateOfBirth) > ${TODAY_IN_INDIA} THEN 1 ELSE 0 END
        END AS Age,
        CASE WHEN NULLIF(LTRIM(RTRIM(${u}.Gender)), '') IS NULL THEN 'Unknown'
             WHEN LTRIM(${u}.Gender) LIKE 'M%' THEN 'Male'
             WHEN LTRIM(${u}.Gender) LIKE 'F%' THEN 'Female'
             ELSE 'Other' END AS Gender) ${alias}_raw
    CROSS APPLY (SELECT ${alias}_raw.Gender AS Gender,
        CASE WHEN ${alias}_raw.Age IS NULL OR ${alias}_raw.Age < 0 OR ${alias}_raw.Age > 120 THEN 'Unknown'
             WHEN ${alias}_raw.Age < 18 THEN '0-17'
             WHEN ${alias}_raw.Age < 30 THEN '18-29'
             WHEN ${alias}_raw.Age < 45 THEN '30-44'
             WHEN ${alias}_raw.Age < 60 THEN '45-59'
             ELSE '60+' END AS AgeBand) ${alias}`;

const personConditions = (alias: string) =>
    ` AND (${P.gender} IS NULL OR ${alias}.Gender = ${P.gender}) AND (${P.ageBand} IS NULL OR ${alias}.AgeBand = ${P.ageBand})`;

/** The hospital aliased `h` is in the chosen state / city / pincode (a missing hospital passes only when none is chosen). */
const locationConditions = (h: string) =>
    ` AND (${P.state} IS NULL OR LTRIM(RTRIM(${h}.State)) = ${P.state})` +
    ` AND (${P.city} IS NULL OR LTRIM(RTRIM(${h}.City)) = ${P.city})` +
    ` AND (${P.pincode} IS NULL OR LTRIM(RTRIM(${h}.Pincode)) = ${P.pincode})`;

const anyLocationChosen = `(${P.state} IS NOT NULL OR ${P.city} IS NOT NULL OR ${P.pincode} IS NOT NULL)`;

/** The DX row aliased `dx` matches the disease filter: its text contains it, or its concept id equals it. */
const diseaseMatch = (dx: string) =>
    `(${P.diseaseLike} IS NULL OR ${dx}.Diagnosis LIKE ${P.diseaseLike} ESCAPE '\\' OR ${dx}.ConceptId = ${P.diseaseExact})`;

/** The patient (column) matches the disease filter, or there is none. */
const diseasePatient = (patientIdColumn: string) =>
    `(${P.diseasePatients} IS NULL OR ${patientIdColumn} IN (${jsonIds(P.diseasePatients, "dxp")}))`;

/** The provider (user id column) has the chosen specialty, or none is chosen. */
const providerSpecialty = (providerUserIdColumn: string) =>
    `(${P.specialty} IS NULL OR EXISTS (SELECT 1 FROM HealthcareProviders sp WHERE sp.UserId = ${providerUserIdColumn} AND sp.IsDeleted = 0 AND LTRIM(RTRIM(sp.Specialty)) = ${P.specialty}))`;

const bucket = (column: string, granularity: Granularity): string => {
    const day = `CAST(${column} AS date)`;
    if (granularity === "day") return day;
    if (granularity === "month") return `DATEFROMPARTS(YEAR(${day}), MONTH(${day}), 1)`;
    // Weeks start on Monday; 1900-01-01 was a Monday.
    return `DATEADD(DAY, -(DATEDIFF(DAY, CAST('19000101' AS date), ${day}) % 7), ${day})`;
};

/**
 * Every recorded diagnosis, one row each: PatientId, HospitalId, OrganizationId, Diagnosis,
 * ConceptId (SNOMED; NULL for custom codes) and DiagnosedAt.
 */
const DIAGNOSES_CTE = `
    DX_RAW AS (
        SELECT COALESCE(TRY_CAST(pp.PatientId AS uniqueidentifier), ap.UserId) AS PatientId,
               pp.HospitalId, pp.OrganizationId,
               LTRIM(RTRIM(pd.Diagnosis)) AS Diagnosis,
               CASE WHEN pd.DiagnosisConceptId NOT LIKE 'custom%' THEN LTRIM(RTRIM(pd.DiagnosisConceptId)) END AS ConceptId,
               COALESCE(pp.[Date], pp.CreatedAt, pd.CreatedAt) AS DiagnosedAt
        FROM PrescriptionDiagnosis pd
        INNER JOIN PatientPrescription pp ON pp.Id = pd.PrescriptionId
        -- Some prescriptions carry "APT-<n>" instead of the patient's id: use the appointment's patient.
        LEFT JOIN Appointments ap ON ap.Id = TRY_CAST(pp.AppointmentId AS int)
        UNION ALL
        SELECT TRY_CAST(mr.PatientId AS uniqueidentifier), mr.HospitalId, mr.OrganizationId,
               LTRIM(RTRIM(s.value)), NULL, COALESCE(mr.[Date], mr.CreatedAt)
        FROM PatientMedicalRecord mr
        CROSS APPLY STRING_SPLIT(mr.Diagnosis, ',') s
        WHERE mr.Diagnosis IS NOT NULL AND ISNULL(mr.[Type], '') NOT LIKE '%vital%'
        UNION ALL
        SELECT ds.PatientId, ds.HospitalId, ds.OrganizationId,
               LTRIM(RTRIM(j.[text])),
               CASE WHEN j.conceptId NOT LIKE 'custom%' THEN j.conceptId END,
               COALESCE(ds.DischargedAt, ds.CreatedAt)
        FROM DischargeSummaries ds
        CROSS APPLY OPENJSON(CASE WHEN ISJSON(ds.Diagnoses) = 1 THEN ds.Diagnoses ELSE '[]' END)
             WITH ([text] nvarchar(500) '$.text', conceptId nvarchar(100) '$.conceptId') j
        WHERE ds.IsDeleted = 0
    ),
    DX AS (
        SELECT d.PatientId, d.HospitalId, d.OrganizationId, d.ConceptId, d.DiagnosedAt, c.Diagnosis
        FROM DX_RAW d
        -- A stray trailing comma or full stop ("dolo,") would otherwise split one condition in two.
        CROSS APPLY (SELECT CASE WHEN RIGHT(d.Diagnosis, 1) IN (',', '.', ';')
                                 THEN LTRIM(RTRIM(LEFT(d.Diagnosis, LEN(d.Diagnosis) - 1)))
                                 ELSE d.Diagnosis END AS Diagnosis) c
        WHERE d.PatientId IS NOT NULL AND NULLIF(c.Diagnosis, '') IS NOT NULL
    )`;

/**
 * In-scope role grants: G(UserId, RoleId, RoleName, OrganizationId, HospitalId, CreatedAt,
 * IsActive, Gender, AgeBand). The disease filter narrows Patient rows and the specialty filter
 * narrows Provider rows; other roles pass through them.
 */
const GRANTS_CTE = `
    G AS (
        SELECT ur.UserId, ur.RoleId, r.RoleName, ur.OrganizationId, ur.HospitalId, ur.CreatedAt,
               CASE WHEN ur.Status = 1 AND u.Status = 1 THEN 1 ELSE 0 END AS IsActive,
               gp.Gender, gp.AgeBand
        FROM UserRoles ur
        INNER JOIN Roles r ON r.Id = ur.RoleId
        INNER JOIN Users u ON u.Id = ur.UserId
        LEFT JOIN Hospitals h ON h.Id = ur.HospitalId
        ${person("u", "gp")}
        WHERE ur.IsDeleted = 0 AND u.IsDeleted = 0
          AND (${P.roleIds} IS NULL OR ur.RoleId IN (${jsonIds(P.roleIds, "rid")}))
          AND (${P.organizationId} IS NULL OR ur.OrganizationId = ${P.organizationId})
          AND (${P.hospitalId} IS NULL OR ur.HospitalId = ${P.hospitalId})
          ${personConditions("gp")}
          ${locationConditions("h")}
          AND (r.RoleName <> 'Patient' OR ${diseasePatient("ur.UserId")})
          AND (r.RoleName <> 'Provider' OR ${providerSpecialty("ur.UserId")})
    )`;

/**
 * Appointments from the start of the previous period to the end of this one:
 * A(AppointmentDate, HospitalId, OrgId, DoctorId, Status, StatusGroup, IsTele).
 * Filters apply to the appointment's hospital and patient; specialty to its doctor.
 */
const APPOINTMENTS_CTE = `
    A AS (
        SELECT a.AppointmentDate, a.HospitalId, a.OrgId, a.DoctorId, a.Status,
               CASE WHEN a.Status LIKE 'complete%' THEN 'Completed'
                    WHEN a.Status LIKE 'cancel%' THEN 'Cancelled'
                    ELSE 'Open' END AS StatusGroup,
               CASE WHEN a.IsTeleConsultation = 1 THEN 1 ELSE 0 END AS IsTele
        FROM Appointments a
        LEFT JOIN Users u ON u.Id = a.UserId
        LEFT JOIN Hospitals h ON h.Id = a.HospitalId
        ${person("u", "apx")}
        WHERE a.AppointmentDate >= ${P.previousFrom} AND a.AppointmentDate < ${P.toExclusive}
          AND (u.Id IS NULL OR u.IsDeleted = 0)
          AND (${P.organizationId} IS NULL OR a.OrgId = ${P.organizationId})
          AND (${P.hospitalId} IS NULL OR a.HospitalId = ${P.hospitalId})
          ${personConditions("apx")}
          ${locationConditions("h")}
          AND ${diseasePatient("a.UserId")}
          AND ${providerSpecialty("a.DoctorId")}
    )`;

/** The typed parameter list every query takes, in the order of `P`. */
function parameters(filters: CeoDashboardFilters, range: DashboardRange, diseasePatientsJson: string | null): MssqlParameter[] {
    const text = (value: string | null, length: number) => new MssqlParameter(value, "nvarchar", length);
    const int = (value: number | null) => new MssqlParameter(value, "int");
    return [
        text(range.from, 10),
        text(range.to, 10),
        text(range.previousFrom, 10),
        int(filters.organizationId),
        int(filters.hospitalId),
        text(filters.gender, 20),
        text(filters.ageBand, 20),
        text(filters.state, 100),
        text(filters.city, 100),
        text(filters.pincode, 20),
        text(filters.specialty, 200),
        text(filters.roleIds.length ? JSON.stringify(filters.roleIds) : null, MAX_LENGTH),
        text(filters.disease ? diseasePatientsJson ?? "[]" : null, MAX_LENGTH),
        text(filters.disease ? containsPattern(filters.disease) : null, 400),
        text(filters.disease, 200),
    ];
}

const num = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

export interface RoleRow { roleId: string; roleName: string; activeUsers: number; allUsers: number; newUsers: number; previousNewUsers: number }
export interface SliceRow { label: string; activeUsers: number; allUsers: number; newUsers: number }
export interface TrendPoint { bucket: string; total: number; byRole: Record<string, number> }
export interface ProviderSlice { key: string; label: string; organizationName?: string | null; providers: number; active: number; consulting: number }
export interface AppointmentPoint { bucket: string; total: number; completed: number; cancelled: number }
export interface PlaceRow {
    id: number; name: string; organizationName?: string | null; city?: string | null; state?: string | null; hospitals?: number;
    patients: number; newPatients: number; providers: number; staff: number; newUsers: number; appointments: number; completedAppointments: number;
}
export interface DiagnosisRow { diagnosis: string; conceptId: string | null; patients: number; mentions: number }

export interface CeoDashboardSummary {
    range: DashboardRange;
    filters: CeoDashboardFilters;
    totals: { activeUsers: number; allUsers: number; newUsers: number; previousNewUsers: number };
    roles: RoleRow[];
    onboardingTrend: TrendPoint[];
    demographics: { gender: SliceRow[]; ageBand: SliceRow[] };
    providers: { total: number; active: number; inactive: number; consulting: number; bySpecialty: ProviderSlice[]; byHospital: ProviderSlice[] };
    appointments: {
        total: number; previousTotal: number; completed: number; cancelled: number; open: number; teleconsults: number;
        trend: AppointmentPoint[]; byStatus: { status: string; count: number }[];
    };
    entities: { hospitals: number; newHospitals: number; organizations: number; newOrganizations: number };
    /**
     * Every account, as User Management counts them (not deleted, with or without a role), and why
     * some are not "onboarded" here. Platform-wide: filters do not apply.
     */
    accounts: { total: number; active: number; withoutRole: number; familyMembers: number; roleRemoved: number; neverAssigned: number };
    hospitals: PlaceRow[];
    organizations: PlaceRow[];
    diagnoses: { diagnosedPatients: number; mentions: number; top: DiagnosisRow[] };
}

export interface CeoDashboardFilterOptions {
    roles: { id: string; name: string }[];
    organizations: { id: number; name: string }[];
    hospitals: { id: number; name: string; organizationId: number | null }[];
    states: string[];
    cities: { city: string; state: string | null }[];
    specialties: string[];
    diseases: { diagnosis: string; patients: number }[];
    genders: readonly string[];
    ageBands: readonly string[];
    /** The first onboarding date on record, for an "All time" range. */
    earliestDate: string | null;
}

/** One summary request: the filters, the period and the typed parameters every query shares. */
class Request {
    readonly params: MssqlParameter[];

    constructor(readonly filters: CeoDashboardFilters, readonly range: DashboardRange, diseasePatientsJson: string | null = null) {
        this.params = parameters(filters, range, diseasePatientsJson);
    }

    bucket(column: string) { return bucket(column, this.range.granularity); }

    async run(sql: string): Promise<any[]> {
        const rows = await AppDataSource.query(sql, this.params);
        return Array.isArray(rows) ? rows : [];
    }
}

class CeoDashboardService {
    async getFilterOptions(): Promise<CeoDashboardFilterOptions> {
        const optionsSql = `
            SELECT 'role' AS Kind, CAST(Id AS varchar(36)) AS Value, RoleName AS Label, CAST(NULL AS nvarchar(200)) AS Extra FROM Roles WHERE Status = 1
            UNION ALL SELECT 'organization', CAST(Id AS varchar(20)), Name, NULL FROM Organizations
            UNION ALL SELECT 'hospital', CAST(Id AS varchar(20)), Name, CAST(OrganizationId AS varchar(20)) FROM Hospitals WHERE ISNULL(IsDeleted, 0) = 0
            UNION ALL SELECT DISTINCT 'state', LTRIM(RTRIM(State)), LTRIM(RTRIM(State)), NULL FROM Hospitals WHERE ISNULL(IsDeleted, 0) = 0 AND NULLIF(LTRIM(RTRIM(State)), '') IS NOT NULL
            UNION ALL SELECT DISTINCT 'city', LTRIM(RTRIM(City)), LTRIM(RTRIM(City)), LTRIM(RTRIM(State)) FROM Hospitals WHERE ISNULL(IsDeleted, 0) = 0 AND NULLIF(LTRIM(RTRIM(City)), '') IS NOT NULL
            UNION ALL SELECT DISTINCT 'specialty', LTRIM(RTRIM(Specialty)), LTRIM(RTRIM(Specialty)), NULL FROM HealthcareProviders WHERE IsDeleted = 0 AND NULLIF(LTRIM(RTRIM(Specialty)), '') IS NOT NULL
            UNION ALL SELECT 'earliest', CONVERT(char(10), MIN(CreatedAt), 23), NULL, NULL FROM UserRoles WHERE IsDeleted = 0`;
        const diseasesSql = `
            WITH ${DIAGNOSES_CTE}
            SELECT TOP 200 MIN(Diagnosis) AS Diagnosis, COUNT(DISTINCT PatientId) AS Patients
            FROM DX GROUP BY Diagnosis ORDER BY COUNT(DISTINCT PatientId) DESC, MIN(Diagnosis)`;

        const [options, diseases] = await Promise.all([AppDataSource.query(optionsSql), AppDataSource.query(diseasesSql)]) as [any[], any[]];
        const byKind = (kind: string) => options.filter((o) => o.Kind === kind);
        const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

        return {
            roles: byKind("role").map((o) => ({ id: String(o.Value).toUpperCase(), name: String(o.Label) })).sort(byName),
            organizations: byKind("organization").map((o) => ({ id: num(o.Value), name: String(o.Label ?? "").trim() })).sort(byName),
            hospitals: byKind("hospital").map((o) => ({ id: num(o.Value), name: String(o.Label ?? "").trim(), organizationId: o.Extra ? num(o.Extra) : null })).sort(byName),
            states: byKind("state").map((o) => String(o.Value)).sort(),
            cities: byKind("city").map((o) => ({ city: String(o.Value), state: o.Extra ?? null })).sort((a, b) => a.city.localeCompare(b.city)),
            specialties: byKind("specialty").map((o) => String(o.Value)).sort(),
            diseases: diseases.map((d) => ({ diagnosis: String(d.Diagnosis), patients: num(d.Patients) })),
            genders: GENDERS,
            ageBands: AGE_BANDS,
            earliestDate: byKind("earliest")[0]?.Value ?? null,
        };
    }

    async getSummary(filters: CeoDashboardFilters): Promise<CeoDashboardSummary> {
        const range = dashboardRange(filters);
        const diseasePatients = filters.disease ? await this.diseasePatientIds(new Request(filters, range)) : null;
        const request = new Request(filters, range, diseasePatients);
        const [users, roles, trend, providers, appointments, hospitals, organizations, entities, diagnoses, accounts] = await Promise.all([
            this.userTotals(request),
            this.roleRows(request),
            this.onboardingTrend(request),
            this.providerStats(request),
            this.appointmentStats(request),
            this.hospitalRows(request),
            this.organizationRows(request),
            this.entityCounts(request),
            this.diagnosisStats(request),
            this.accountCounts(),
        ]);

        return {
            range,
            filters,
            totals: users.totals,
            roles,
            onboardingTrend: trend,
            demographics: users.demographics,
            providers,
            appointments,
            entities,
            accounts,
            hospitals,
            organizations,
            diagnoses,
        };
    }

    /** All accounts, matching User Management's "Total users" / "Active users", and the ones with no role. */
    private async accountCounts(): Promise<CeoDashboardSummary["accounts"]> {
        const rows = await AppDataSource.query(`
            SELECT COUNT(*) AS Total,
                   SUM(CASE WHEN u.Status = 1 THEN 1 ELSE 0 END) AS Active,
                   SUM(CASE WHEN r.HasRole = 0 THEN 1 ELSE 0 END) AS WithoutRole,
                   SUM(CASE WHEN r.HasRole = 0 AND u.ParentUserId IS NOT NULL THEN 1 ELSE 0 END) AS FamilyMembers,
                   SUM(CASE WHEN r.HasRole = 0 AND u.ParentUserId IS NULL AND r.HadRole = 1 THEN 1 ELSE 0 END) AS RoleRemoved,
                   SUM(CASE WHEN r.HasRole = 0 AND u.ParentUserId IS NULL AND r.HadRole = 0 THEN 1 ELSE 0 END) AS NeverAssigned
            FROM Users u
            CROSS APPLY (SELECT
                CASE WHEN EXISTS (SELECT 1 FROM UserRoles ur WHERE ur.UserId = u.Id AND ur.IsDeleted = 0) THEN 1 ELSE 0 END AS HasRole,
                CASE WHEN EXISTS (SELECT 1 FROM UserRoles ur WHERE ur.UserId = u.Id) THEN 1 ELSE 0 END AS HadRole) r
            WHERE u.IsDeleted = 0`) as any[];
        const row = rows[0] ?? {};
        return {
            total: num(row.Total),
            active: num(row.Active),
            withoutRole: num(row.WithoutRole),
            familyMembers: num(row.FamilyMembers),
            roleRemoved: num(row.RoleRemoved),
            neverAssigned: num(row.NeverAssigned),
        };
    }

    /**
     * Patients with any recorded diagnosis matching the disease filter (ever, anywhere), as a JSON
     * array of ids. Resolving them once keeps the diagnoses CTE out of every other query.
     */
    private async diseasePatientIds(q: Request): Promise<string> {
        const rows = await q.run(`
            WITH ${DIAGNOSES_CTE}
            SELECT DISTINCT CAST(DX.PatientId AS varchar(36)) AS PatientId FROM DX WHERE ${diseaseMatch("DX")}`);
        return JSON.stringify(rows.map((r) => String(r.PatientId)));
    }

    /** Distinct users in scope, overall and by gender / age band. */
    private async userTotals(q: Request) {
        const rows = await q.run(`
            WITH ${GRANTS_CTE},
            UU AS (
                SELECT UserId, MIN(CreatedAt) AS FirstAt, MAX(IsActive) AS IsActive, MAX(Gender) AS Gender, MAX(AgeBand) AS AgeBand
                FROM G GROUP BY UserId
            )
            SELECT CASE WHEN GROUPING(Gender) = 0 THEN 'gender' WHEN GROUPING(AgeBand) = 0 THEN 'ageBand' ELSE 'total' END AS Dim,
                   COALESCE(Gender, AgeBand, 'all') AS Value,
                   SUM(IsActive) AS ActiveUsers, COUNT(*) AS AllUsers,
                   SUM(CASE WHEN ${inPeriod("FirstAt")} THEN 1 ELSE 0 END) AS NewUsers,
                   SUM(CASE WHEN ${inPreviousPeriod("FirstAt")} THEN 1 ELSE 0 END) AS PreviousNewUsers
            FROM UU
            GROUP BY GROUPING SETS ((), (Gender), (AgeBand))`);
        const total = rows.find((r) => r.Dim === "total");
        const slices = (dim: string, order: readonly string[]): SliceRow[] => order.map((label) => {
            const row = rows.find((r) => r.Dim === dim && r.Value === label);
            return { label, activeUsers: num(row?.ActiveUsers), allUsers: num(row?.AllUsers), newUsers: num(row?.NewUsers) };
        });
        return {
            totals: {
                activeUsers: num(total?.ActiveUsers),
                allUsers: num(total?.AllUsers),
                newUsers: num(total?.NewUsers),
                previousNewUsers: num(total?.PreviousNewUsers),
            },
            demographics: { gender: slices("gender", GENDERS), ageBand: slices("ageBand", AGE_BANDS) },
        };
    }

    /** Per role: distinct users (active / all) and how many were first onboarded into it this period and last. */
    private async roleRows(q: Request): Promise<RoleRow[]> {
        const rows = await q.run(`
            WITH ${GRANTS_CTE},
            UR AS (
                SELECT UserId, RoleId, MIN(CreatedAt) AS FirstAt, MAX(IsActive) AS IsActive
                FROM G GROUP BY UserId, RoleId
            )
            SELECT CAST(r.Id AS varchar(36)) AS RoleId, r.RoleName,
                   ISNULL(SUM(UR.IsActive), 0) AS ActiveUsers, COUNT(UR.UserId) AS AllUsers,
                   SUM(CASE WHEN ${inPeriod("UR.FirstAt")} THEN 1 ELSE 0 END) AS NewUsers,
                   SUM(CASE WHEN ${inPreviousPeriod("UR.FirstAt")} THEN 1 ELSE 0 END) AS PreviousNewUsers
            FROM Roles r
            LEFT JOIN UR ON UR.RoleId = r.Id
            WHERE r.Status = 1 AND (${P.roleIds} IS NULL OR r.Id IN (${jsonIds(P.roleIds, "rf")}))
            GROUP BY r.Id, r.RoleName
            ORDER BY COUNT(UR.UserId) DESC, r.RoleName`);
        return rows.map((r) => ({
            roleId: String(r.RoleId).toUpperCase(),
            roleName: String(r.RoleName),
            activeUsers: num(r.ActiveUsers),
            allUsers: num(r.AllUsers),
            newUsers: num(r.NewUsers),
            previousNewUsers: num(r.PreviousNewUsers),
        }));
    }

    /** New onboardings per bucket, by role, plus distinct new users per bucket. */
    private async onboardingTrend(q: Request): Promise<TrendPoint[]> {
        const rows = await q.run(`
            WITH ${GRANTS_CTE},
            UR AS (SELECT UserId, RoleName, MIN(CreatedAt) AS FirstAt FROM G GROUP BY UserId, RoleName),
            UU AS (SELECT UserId, MIN(CreatedAt) AS FirstAt FROM G GROUP BY UserId)
            SELECT CONVERT(char(10), b.Bucket, 23) AS Bucket, UR.RoleName AS Series, COUNT(*) AS Value
            FROM UR CROSS APPLY (SELECT ${q.bucket("UR.FirstAt")} AS Bucket) b
            WHERE ${inPeriod("UR.FirstAt")}
            GROUP BY b.Bucket, UR.RoleName
            UNION ALL
            SELECT CONVERT(char(10), b.Bucket, 23), '__total__', COUNT(*)
            FROM UU CROSS APPLY (SELECT ${q.bucket("UU.FirstAt")} AS Bucket) b
            WHERE ${inPeriod("UU.FirstAt")}
            GROUP BY b.Bucket`);
        return q.range.buckets.map((bucketStart) => {
            const point: TrendPoint = { bucket: bucketStart, total: 0, byRole: {} };
            for (const row of rows) {
                if (row.Bucket !== bucketStart) continue;
                if (row.Series === "__total__") point.total = num(row.Value);
                else point.byRole[String(row.Series)] = num(row.Value);
            }
            return point;
        });
    }

    /** Provider profiles: totals, by specialty and by hospital. Role and disease filters do not apply. */
    private async providerStats(q: Request): Promise<CeoDashboardSummary["providers"]> {
        const rows = await q.run(`
            WITH P AS (
                SELECT hp.UserId, hp.HospitalId, h.Name AS HospitalName, o.Name AS OrganizationName,
                       COALESCE(NULLIF(LTRIM(RTRIM(hp.Specialty)), ''), 'Unspecified') AS Specialty,
                       CASE WHEN hp.Status = 1 AND u.Status = 1 THEN 1 ELSE 0 END AS IsActive
                FROM HealthcareProviders hp
                INNER JOIN Users u ON u.Id = hp.UserId
                LEFT JOIN Hospitals h ON h.Id = hp.HospitalId
                LEFT JOIN Organizations o ON o.Id = h.OrganizationId
                ${person("u", "pp")}
                WHERE hp.IsDeleted = 0 AND u.IsDeleted = 0
                  AND (${P.organizationId} IS NULL OR h.OrganizationId = ${P.organizationId})
                  AND (${P.hospitalId} IS NULL OR hp.HospitalId = ${P.hospitalId})
                  AND (${P.specialty} IS NULL OR LTRIM(RTRIM(hp.Specialty)) = ${P.specialty})
                  ${personConditions("pp")}
                  ${locationConditions("h")}
            ),
            C AS (
                SELECT DISTINCT a.DoctorId, a.HospitalId FROM Appointments a
                WHERE ${inPeriod("a.AppointmentDate")} AND ISNULL(a.Status, '') NOT LIKE 'cancel%'
            ),
            PX AS (
                SELECT P.*, CASE WHEN EXISTS (SELECT 1 FROM C WHERE C.DoctorId = P.UserId AND C.HospitalId = P.HospitalId) THEN 1 ELSE 0 END AS Consulting
                FROM P
            )
            SELECT CASE WHEN GROUPING(Specialty) = 0 THEN 'specialty' WHEN GROUPING(HospitalId) = 0 THEN 'hospital' ELSE 'total' END AS Dim,
                   CASE WHEN GROUPING(Specialty) = 0 THEN Specialty ELSE CAST(HospitalId AS nvarchar(20)) END AS [Key],
                   CASE WHEN GROUPING(Specialty) = 0 THEN Specialty ELSE MIN(HospitalName) END AS Label,
                   MIN(OrganizationName) AS Extra,
                   COUNT(DISTINCT UserId) AS Providers,
                   COUNT(DISTINCT CASE WHEN IsActive = 1 THEN UserId END) AS Active,
                   COUNT(DISTINCT CASE WHEN Consulting = 1 THEN UserId END) AS Consulting
            FROM PX
            GROUP BY GROUPING SETS ((), (Specialty), (HospitalId))`);
        const total = rows.find((r) => r.Dim === "total");
        const slices = (dim: string): ProviderSlice[] => rows
            .filter((r) => r.Dim === dim)
            .map((r) => ({
                key: String(r.Key ?? ""),
                label: String(r.Label ?? "No hospital"),
                organizationName: dim === "hospital" ? r.Extra ?? null : null,
                providers: num(r.Providers),
                active: num(r.Active),
                consulting: num(r.Consulting),
            }))
            .sort((a, b) => b.providers - a.providers || a.label.localeCompare(b.label));
        const providers = num(total?.Providers);
        const active = num(total?.Active);
        return {
            total: providers,
            active,
            inactive: providers - active,
            consulting: num(total?.Consulting),
            bySpecialty: slices("specialty"),
            byHospital: slices("hospital").slice(0, 25),
        };
    }

    /** Appointments in the period: totals, trend and status mix, with the previous period's total. */
    private async appointmentStats(q: Request): Promise<CeoDashboardSummary["appointments"]> {
        const rows = await q.run(`
            WITH ${APPOINTMENTS_CTE},
            AP AS (
                SELECT A.*, CASE WHEN A.AppointmentDate >= ${P.from} THEN 1 ELSE 0 END AS IsCurrent,
                       LOWER(ISNULL(A.Status, '')) AS StatusKey, b.Bucket
                FROM A CROSS APPLY (SELECT ${q.bucket("A.AppointmentDate")} AS Bucket) b
            )
            SELECT CASE WHEN GROUPING(Bucket) = 0 THEN 'bucket' WHEN GROUPING(StatusKey) = 0 THEN 'status' ELSE 'period' END AS Dim,
                   IsCurrent,
                   CASE WHEN GROUPING(Bucket) = 0 THEN CONVERT(char(10), Bucket, 23) ELSE MIN(ISNULL(Status, '')) END AS [Key],
                   COUNT(*) AS Total,
                   SUM(CASE WHEN StatusGroup = 'Completed' THEN 1 ELSE 0 END) AS Completed,
                   SUM(CASE WHEN StatusGroup = 'Cancelled' THEN 1 ELSE 0 END) AS Cancelled,
                   SUM(IsTele) AS Tele
            FROM AP
            GROUP BY GROUPING SETS ((IsCurrent), (IsCurrent, Bucket), (IsCurrent, StatusKey))`);
        const current = rows.filter((r) => num(r.IsCurrent) === 1);
        const period = current.find((r) => r.Dim === "period");
        const trend = q.range.buckets.map((bucketStart) => {
            const row = current.find((r) => r.Dim === "bucket" && r.Key === bucketStart);
            return { bucket: bucketStart, total: num(row?.Total), completed: num(row?.Completed), cancelled: num(row?.Cancelled) };
        });
        const total = num(period?.Total);
        const completed = num(period?.Completed);
        const cancelled = num(period?.Cancelled);
        return {
            total,
            previousTotal: num(rows.find((r) => r.Dim === "period" && num(r.IsCurrent) === 0)?.Total),
            completed,
            cancelled,
            open: total - completed - cancelled,
            teleconsults: num(period?.Tele),
            trend,
            byStatus: current
                .filter((r) => r.Dim === "status")
                .map((r) => ({ status: statusLabel(r.Key), count: num(r.Total) }))
                .sort((a, b) => b.count - a.count),
        };
    }

    /** Per hospital: users by kind, new onboardings and appointments in the period. Top 50. */
    private async hospitalRows(q: Request): Promise<PlaceRow[]> {
        const rows = await q.run(`
            WITH ${GRANTS_CTE}, ${APPOINTMENTS_CTE},
            HG AS (
                SELECT HospitalId,
                       COUNT(DISTINCT CASE WHEN RoleName = 'Patient' AND IsActive = 1 THEN UserId END) AS Patients,
                       COUNT(DISTINCT CASE WHEN RoleName = 'Patient' AND ${inPeriod("CreatedAt")} THEN UserId END) AS NewPatients,
                       COUNT(DISTINCT CASE WHEN RoleName = 'Provider' AND IsActive = 1 THEN UserId END) AS Providers,
                       COUNT(DISTINCT CASE WHEN RoleName NOT IN ('Patient', 'Provider') AND IsActive = 1 THEN UserId END) AS Staff,
                       COUNT(DISTINCT CASE WHEN ${inPeriod("CreatedAt")} THEN UserId END) AS NewUsers
                FROM G WHERE HospitalId IS NOT NULL GROUP BY HospitalId
            ),
            HA AS (
                SELECT HospitalId, COUNT(*) AS Appointments, SUM(CASE WHEN StatusGroup = 'Completed' THEN 1 ELSE 0 END) AS Completed
                FROM A WHERE AppointmentDate >= ${P.from} AND HospitalId IS NOT NULL GROUP BY HospitalId
            )
            SELECT TOP 50 h.Id, h.Name, o.Name AS OrganizationName, h.City, h.State,
                   ISNULL(HG.Patients, 0) AS Patients, ISNULL(HG.NewPatients, 0) AS NewPatients,
                   ISNULL(HG.Providers, 0) AS Providers, ISNULL(HG.Staff, 0) AS Staff, ISNULL(HG.NewUsers, 0) AS NewUsers,
                   ISNULL(HA.Appointments, 0) AS Appointments, ISNULL(HA.Completed, 0) AS Completed
            FROM HG
            FULL OUTER JOIN HA ON HA.HospitalId = HG.HospitalId
            INNER JOIN Hospitals h ON h.Id = COALESCE(HG.HospitalId, HA.HospitalId)
            LEFT JOIN Organizations o ON o.Id = h.OrganizationId
            ORDER BY ISNULL(HG.NewUsers, 0) DESC, ISNULL(HA.Appointments, 0) DESC, ISNULL(HG.Patients, 0) DESC, h.Name`);
        return rows.map((r) => ({
            id: num(r.Id),
            name: String(r.Name ?? "").trim(),
            organizationName: r.OrganizationName?.trim() ?? null,
            city: r.City ?? null,
            state: r.State ?? null,
            patients: num(r.Patients),
            newPatients: num(r.NewPatients),
            providers: num(r.Providers),
            staff: num(r.Staff),
            newUsers: num(r.NewUsers),
            appointments: num(r.Appointments),
            completedAppointments: num(r.Completed),
        }));
    }

    /** Per organisation: the same as per hospital, plus its hospital count. Top 50. */
    private async organizationRows(q: Request): Promise<PlaceRow[]> {
        const rows = await q.run(`
            WITH ${GRANTS_CTE}, ${APPOINTMENTS_CTE},
            OG AS (
                SELECT OrganizationId,
                       COUNT(DISTINCT CASE WHEN RoleName = 'Patient' AND IsActive = 1 THEN UserId END) AS Patients,
                       COUNT(DISTINCT CASE WHEN RoleName = 'Patient' AND ${inPeriod("CreatedAt")} THEN UserId END) AS NewPatients,
                       COUNT(DISTINCT CASE WHEN RoleName = 'Provider' AND IsActive = 1 THEN UserId END) AS Providers,
                       COUNT(DISTINCT CASE WHEN RoleName NOT IN ('Patient', 'Provider') AND IsActive = 1 THEN UserId END) AS Staff,
                       COUNT(DISTINCT CASE WHEN ${inPeriod("CreatedAt")} THEN UserId END) AS NewUsers
                FROM G WHERE OrganizationId IS NOT NULL GROUP BY OrganizationId
            ),
            OA AS (
                SELECT OrgId, COUNT(*) AS Appointments, SUM(CASE WHEN StatusGroup = 'Completed' THEN 1 ELSE 0 END) AS Completed
                FROM A WHERE AppointmentDate >= ${P.from} AND OrgId IS NOT NULL GROUP BY OrgId
            )
            SELECT TOP 50 o.Id, o.Name,
                   (SELECT COUNT(*) FROM Hospitals hh
                    WHERE hh.OrganizationId = o.Id AND ISNULL(hh.IsDeleted, 0) = 0
                      AND (${P.hospitalId} IS NULL OR hh.Id = ${P.hospitalId}) ${locationConditions("hh")}) AS Hospitals,
                   ISNULL(OG.Patients, 0) AS Patients, ISNULL(OG.NewPatients, 0) AS NewPatients,
                   ISNULL(OG.Providers, 0) AS Providers, ISNULL(OG.Staff, 0) AS Staff, ISNULL(OG.NewUsers, 0) AS NewUsers,
                   ISNULL(OA.Appointments, 0) AS Appointments, ISNULL(OA.Completed, 0) AS Completed
            FROM OG
            FULL OUTER JOIN OA ON OA.OrgId = OG.OrganizationId
            INNER JOIN Organizations o ON o.Id = COALESCE(OG.OrganizationId, OA.OrgId)
            ORDER BY ISNULL(OG.NewUsers, 0) DESC, ISNULL(OA.Appointments, 0) DESC, ISNULL(OG.Patients, 0) DESC, o.Name`);
        return rows.map((r) => ({
            id: num(r.Id),
            name: String(r.Name ?? "").trim(),
            hospitals: num(r.Hospitals),
            patients: num(r.Patients),
            newPatients: num(r.NewPatients),
            providers: num(r.Providers),
            staff: num(r.Staff),
            newUsers: num(r.NewUsers),
            appointments: num(r.Appointments),
            completedAppointments: num(r.Completed),
        }));
    }

    /** Hospitals and organisations on the platform, and how many were added in the period. */
    private async entityCounts(q: Request): Promise<CeoDashboardSummary["entities"]> {
        const hospitalWhere = `ISNULL(h.IsDeleted, 0) = 0
            AND (${P.organizationId} IS NULL OR h.OrganizationId = ${P.organizationId})
            AND (${P.hospitalId} IS NULL OR h.Id = ${P.hospitalId}) ${locationConditions("h")}`;
        const orgWhere = `(${P.organizationId} IS NULL OR o.Id = ${P.organizationId})
            AND ((${P.hospitalId} IS NULL AND NOT ${anyLocationChosen})
                 OR EXISTS (SELECT 1 FROM Hospitals h WHERE h.OrganizationId = o.Id AND ${hospitalWhere}))`;
        const row = (await q.run(`
            SELECT
                (SELECT COUNT(*) FROM Hospitals h WHERE ${hospitalWhere}) AS Hospitals,
                (SELECT COUNT(*) FROM Hospitals h WHERE ${hospitalWhere} AND ${inPeriod("h.CreatedAt")}) AS NewHospitals,
                (SELECT COUNT(*) FROM Organizations o WHERE ${orgWhere}) AS Organizations,
                (SELECT COUNT(*) FROM Organizations o WHERE ${orgWhere} AND ${inPeriod("o.CreatedAt")}) AS NewOrganizations`))[0] ?? {};
        return {
            hospitals: num(row.Hospitals),
            newHospitals: num(row.NewHospitals),
            organizations: num(row.Organizations),
            newOrganizations: num(row.NewOrganizations),
        };
    }

    /** Diagnoses recorded in the period: distinct patients and the most common conditions. */
    private async diagnosisStats(q: Request): Promise<CeoDashboardSummary["diagnoses"]> {
        const rows = await q.run(`
            WITH ${DIAGNOSES_CTE},
            D AS (
                SELECT DX.PatientId, DX.Diagnosis, DX.ConceptId
                FROM DX
                LEFT JOIN Users u ON u.Id = DX.PatientId
                LEFT JOIN Hospitals h ON h.Id = DX.HospitalId
                ${person("u", "dp")}
                WHERE ${inPeriod("DX.DiagnosedAt")} AND (u.Id IS NULL OR u.IsDeleted = 0)
                  AND (${P.organizationId} IS NULL OR DX.OrganizationId = ${P.organizationId})
                  AND (${P.hospitalId} IS NULL OR DX.HospitalId = ${P.hospitalId})
                  AND ${diseaseMatch("DX")}
                  ${personConditions("dp")}
                  ${locationConditions("h")}
            ),
            S AS (
                SELECT CASE WHEN GROUPING(Diagnosis) = 1 THEN 1 ELSE 0 END AS IsTotal,
                       MIN(Diagnosis) AS Diagnosis, MAX(ConceptId) AS ConceptId,
                       COUNT(DISTINCT PatientId) AS Patients, COUNT(*) AS Mentions
                FROM D GROUP BY GROUPING SETS ((), (Diagnosis))
            )
            SELECT TOP 26 IsTotal, Diagnosis, ConceptId, Patients, Mentions
            FROM S ORDER BY IsTotal DESC, Patients DESC, Mentions DESC, Diagnosis`);
        const total = rows.find((r) => num(r.IsTotal) === 1);
        return {
            diagnosedPatients: num(total?.Patients),
            mentions: num(total?.Mentions),
            top: rows
                .filter((r) => num(r.IsTotal) === 0)
                .map((r) => ({ diagnosis: String(r.Diagnosis), conceptId: r.ConceptId ?? null, patients: num(r.Patients), mentions: num(r.Mentions) })),
        };
    }
}

export const ceoDashboardService = new CeoDashboardService();
