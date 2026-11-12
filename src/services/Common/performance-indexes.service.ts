/**
 * Indexes for the queries the apps run on every screen open: the token check on every request,
 * the doctor and admin dashboards, appointment lists, patient lists, a patient's overview,
 * documents, prescriptions and slots. Each one names the queries it serves.
 *
 * Every statement is idempotent and conservative. It does nothing when the table or a column is
 * missing, when a key column is NVARCHAR(MAX) (not indexable), when an index of this name exists,
 * or when another index already starts with the same key columns in the same order (so it never
 * adds a duplicate of an index made by hand or by an older migration under another name).
 *
 * Indexes are built ONLINE where the server supports it (Azure SQL Database, Enterprise, Managed
 * Instance), so tables stay writable while they build. They run on their own connection with a
 * long timeout: the app's 30 second request timeout would cancel (and roll back) a build on a
 * large table, and the next start would try again and again. The same SQL is in
 * reports/sql/performance-indexes.sql for running by hand.
 */

export interface PerformanceIndex {
    name: string;
    table: string;
    keys: string[];
    include?: string[];
    /** The queries this index serves. */
    serves: string;
}

export const PERFORMANCE_INDEXES: PerformanceIndex[] = [
    {
        name: "IX_UserTokens_UserId_IsRevoked",
        table: "UserTokens",
        keys: ["UserId", "IsRevoked"],
        serves: "Every authenticated request: findByAccessToken (twice per request: logging and auth middleware) and findByRefreshToken now also filter by the token's UserId, because AccessToken/RefreshToken are NVARCHAR(MAX) and cannot be indexed. Also revokeAllUserTokens, revokePreviousSession, findActiveSession.",
    },
    {
        name: "IX_Appointments_DoctorId_AppointmentDate",
        table: "Appointments",
        keys: ["DoctorId", "AppointmentDate"],
        include: ["UserId", "HospitalId", "OrgId", "Status", "StartTime"],
        serves: "Doctor dashboards (mobile POST /dashboard: today, recent patients, weekly, yearly, first visits; web GET /api/dashboard/doctor), mobile POST /appointment-dashboard, web GET /api/appointments/doctor/:id and ?doctorId=, and the patient list's doctor filter (pr.UserId IN (SELECT a.UserId FROM Appointments a WHERE a.DoctorId = @id)), which is covered by this index.",
    },
    {
        name: "IX_Appointments_UserId_AppointmentDate",
        table: "Appointments",
        keys: ["UserId", "AppointmentDate"],
        include: ["DoctorId", "HospitalId", "OrgId", "Status"],
        serves: "Patient app: POST /patient-appointments, POST /patient/overview (both appointment reads), web GET /api/appointments?userId= and /patient/:userId; patient list visit counts and next appointment (a.UserId IN (...)); the record-access check (has the patient booked at this hospital).",
    },
    {
        name: "IX_Appointments_HospitalId_AppointmentDate",
        table: "Appointments",
        keys: ["HospitalId", "AppointmentDate"],
        include: ["OrgId", "DoctorId", "UserId", "Status", "AppointmentNumber"],
        serves: "Web appointment lists by hospital and date (GET /api/appointments, /hospital), hospital admin dashboard analytics (GET /api/dashboard/admin), and the next token number at booking (MAX(AppointmentNumber) for a hospital and day), which is covered.",
    },
    {
        name: "IX_Appointments_SlotId",
        table: "Appointments",
        keys: ["SlotId"],
        include: ["Status"],
        serves: "Slot lists (mobile POST /doctor-slots, web slots) load each slot's appointments by joining Appointments.SlotId; without an index each slot query reads the whole Appointments table.",
    },
    {
        name: "IX_PatientVerifications_AppointmentId",
        table: "PatientVerifications",
        keys: ["AppointmentId"],
        serves: "Web appointment lists (GET /api/appointments, /doctor/:id) join each appointment's Verifications.",
    },
    {
        name: "IX_HealthcareProviderScheduleSlots_Provider_Hospital_Date",
        table: "HealthcareProviderScheduleSlots",
        keys: ["ProviderId", "HospitalId", "SlotDate"],
        include: ["IsDeleted"],
        serves: "Doctor slots for a day (mobile POST /doctor-slots, booking screens): ProviderId + HospitalId + SlotDate BETWEEN. The daily slot generator keeps adding rows, so this table only grows.",
    },
    {
        name: "IX_PatientRegistrations_UserId",
        table: "PatientRegistrations",
        keys: ["UserId"],
        include: ["OrganizationId", "HospitalId", "IsDeleted", "CreatedAt"],
        serves: "Patient list (GET /api/patients/getpatients, mobile POST /patients): the doctor filter matches pr.UserId to the doctor's patients; patient overview registration; allergies/history on appointment lists (attachMedicalAndInsurance); the record-access check.",
    },
    {
        name: "IX_PatientRegistrations_OrganizationId_CreatedAt",
        table: "PatientRegistrations",
        keys: ["OrganizationId", "CreatedAt"],
        include: ["UserId", "HospitalId", "IsDeleted"],
        serves: "Patient list paging for an organization or hospital: WHERE pr.OrganizationId = @org ... ORDER BY pr.CreatedAt DESC, and its counts.",
    },
    {
        name: "IX_PatientInsurances_UserId",
        table: "PatientInsurances",
        keys: ["UserId"],
        include: ["IsDeleted", "OrganizationId", "HospitalId", "CreatedAt"],
        serves: "Insurance for each listed patient (patient list, appointment lists) and the patient overview.",
    },
    {
        name: "IX_UserRoles_UserId_RoleId",
        table: "UserRoles",
        keys: ["UserId", "RoleId"],
        include: ["OrganizationId", "HospitalId", "Status", "IsDeleted"],
        serves: "Patient list join (ur.UserId = u.Id AND ur.RoleId = patient AND ur.OrganizationId = pr.OrganizationId), web doctor dashboard patient counts, sign-in role lookups, staff checks in the record-access middleware.",
    },
    {
        name: "IX_Users_ParentUserId",
        table: "Users",
        keys: ["ParentUserId"],
        include: ["IsDeleted"],
        serves: "Family members of an account: doctor dashboard and appointment dashboard (dependents), notifications for a family, patient appointments for a family, isFamilyLinked.",
    },
    {
        name: "IX_Users_PhoneNumber",
        table: "Users",
        keys: ["PhoneNumber"],
        include: ["IsDeleted", "IsPrimary", "ParentUserId"],
        serves: "Sign-in and OTP by phone (PhoneNumber = @phone), and the RIGHT(PhoneNumber, 10) family lookups (POST /patient-appointments on the patient home, accounts-by-phone, booking), which then scan this narrow index instead of the whole Users table.",
    },
    {
        name: "IX_MedicalDocuments_PatientId_CreatedAt",
        table: "MedicalDocuments",
        keys: ["PatientId", "CreatedAt"],
        include: ["IsDeleted", "HospitalId", "OrganizationId", "AppointmentId"],
        serves: "Health records list (GET /medical-documents/patient/:id, newest first, TOP n) and the patient overview.",
    },
    {
        name: "IX_PatientPrescription_PatientId_CreatedAt",
        table: "PatientPrescription",
        keys: ["PatientId", "CreatedAt"],
        include: ["HospitalId", "OrganizationId", "AppointmentId"],
        serves: "Prescriptions list (GET /prescriptions/patient/:id on mobile and web) and the patient overview.",
    },
    {
        name: "IX_PrescriptionDiagnosis_PrescriptionId",
        table: "PrescriptionDiagnosis",
        keys: ["PrescriptionId"],
        serves: "Every prescriptions load joins each prescription's diagnoses (relation Diagnoses).",
    },
    {
        name: "IX_PrescriptionMedication_PrescriptionId",
        table: "PrescriptionMedication",
        keys: ["PrescriptionId"],
        serves: "Every prescriptions load joins each prescription's medications (relation Medications).",
    },
    {
        name: "IX_PrescriptionMedicationSchedule_MedicationId",
        table: "PrescriptionMedicationSchedule",
        keys: ["PrescriptionMedicationId"],
        serves: "Prescriptions loads join each medication's schedules (relation Medications.Schedules).",
    },
    {
        name: "IX_PrescriptionMedicationDays_MedicationId",
        table: "PrescriptionMedicationDays",
        keys: ["PrescriptionMedicationId"],
        serves: "Prescriptions loads join each medication's days (relation Medications.Days).",
    },
    {
        name: "IX_PatientClinicalNotes_PatientId_CreatedAt",
        table: "PatientClinicalNotes",
        keys: ["PatientId", "CreatedAt"],
        serves: "Clinical notes of a patient (patient overview, doctor's clinical data screen).",
    },
    {
        name: "IX_MedicalRecords_PatientId_CreatedAt",
        table: "MedicalRecords",
        keys: ["PatientId", "CreatedAt"],
        serves: "Medical records of a patient (patient overview).",
    },
    {
        name: "IX_PatientMedicalRecord_PatientId_Date",
        table: "PatientMedicalRecord",
        keys: ["PatientId", "Date"],
        include: ["CreatedAt"],
        serves: "Latest vitals on the patient overview and profile (TOP 1 ... ORDER BY Date DESC, CreatedAt DESC).",
    },
    {
        name: "IX_PatientAccessConsents_PatientId_DoctorId",
        table: "PatientAccessConsents",
        keys: ["PatientId", "DoctorId"],
        serves: "The record-access middleware on every doctor read of a patient's records (consent for this patient and doctor), and the patient's consents list.",
    },
];

const quoteName = (name: string) => `[${name.replace(/]/g, "]]")}]`;
const literal = (value: string) => `N'${value.replace(/'/g, "''")}'`;

/**
 * T-SQL that creates one index unless the table or a column is missing, a key column is
 * NVARCHAR(MAX), the name is taken, or another index already starts with the same keys.
 * It ends by selecting one row saying what it did.
 */
export function performanceIndexSql(index: PerformanceIndex, online: boolean): string {
    const table = literal(index.table);
    const columns = [...index.keys, ...(index.include ?? [])];
    const sameLeadingKeys = index.keys
        .map((key, i) => `(ic.key_ordinal = ${i + 1} AND c.name = ${literal(key)})`)
        .join(" OR ");
    const include = index.include?.length ? ` INCLUDE (${index.include.map(quoteName).join(", ")})` : "";
    const withOnline = online ? " WITH (ONLINE = ON)" : "";
    return `IF OBJECT_ID(${table}, N'U') IS NULL
    SELECT 'skipped: no table ${index.table}' AS outcome;
ELSE IF EXISTS (SELECT 1 FROM (VALUES ${columns.map(c => `(${literal(c)})`).join(", ")}) AS needed(name) WHERE COL_LENGTH(${table}, needed.name) IS NULL)
    SELECT 'skipped: a column is missing' AS outcome;
ELSE IF EXISTS (SELECT 1 FROM sys.columns c WHERE c.object_id = OBJECT_ID(${table}) AND c.max_length = -1 AND c.name IN (${index.keys.map(literal).join(", ")}))
    SELECT 'skipped: a key column is (max)' AS outcome;
ELSE IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(${table}) AND name = ${literal(index.name)})
    SELECT 'present' AS outcome;
ELSE IF EXISTS (
    SELECT 1 FROM sys.indexes i
    WHERE i.object_id = OBJECT_ID(${table}) AND i.type IN (1, 2) AND i.is_disabled = 0 AND i.has_filter = 0 AND i.is_hypothetical = 0
      AND (SELECT COUNT(*) FROM sys.index_columns ic
           JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
           WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
             AND (${sameLeadingKeys})) = ${index.keys.length}
)
    SELECT 'present under another name' AS outcome;
ELSE
BEGIN
    CREATE NONCLUSTERED INDEX ${quoteName(index.name)} ON ${quoteName(index.table)} (${index.keys.map(quoteName).join(", ")})${include}${withOnline};
    SELECT 'created' AS outcome;
END`;
}

/** Azure SQL Database (5), Enterprise/Developer (3) and Managed Instance (8) build indexes online. */
const ONLINE_EDITIONS = new Set([3, 5, 8]);

/** Long enough for a large table on a small tier; a build cancelled by a timeout is rolled back. */
const BUILD_TIMEOUT_MS = 20 * 60 * 1000;

export class PerformanceIndexService {
    /**
     * Creates any missing index from PERFORMANCE_INDEXES, one at a time. Never throws: a failed
     * index is logged and the rest still run.
     */
    static async ensurePerformanceIndexes(): Promise<void> {
        let pool: any;
        try {
            const { AppDataSource } = await import("../../config/database.js");
            // Its own connection, built the way TypeORM builds the app's pool, but with a long
            // request timeout and a single connection.
            const options = AppDataSource.options as any;
            const config: any = Object.assign({}, {
                connectionTimeout: options.connectionTimeout,
                options: { ...(options.options ?? {}) },
            }, {
                server: options.host,
                database: options.database,
                port: options.port,
                user: options.username,
                password: options.password,
            }, options.extra || {});
            config.options = { ...(config.options ?? {}), useUTC: false, enableArithAbort: true };
            config.requestTimeout = BUILD_TIMEOUT_MS;
            config.pool = { max: 1, min: 0 };
            pool = new (AppDataSource.driver as any).mssql.ConnectionPool(config);
            await pool.connect();

            const run = async (sql: string): Promise<any[]> => (await pool.request().query(sql)).recordset ?? [];
            const [edition] = await run("SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS edition");
            const online = ONLINE_EDITIONS.has(Number(edition?.edition));

            const created: string[] = [];
            const failed: string[] = [];
            for (const index of PERFORMANCE_INDEXES) {
                const started = Date.now();
                const ensure = async (onlineBuild: boolean) =>
                    String((await run(performanceIndexSql(index, onlineBuild)))[0]?.outcome ?? "no outcome");
                try {
                    let outcome: string;
                    try {
                        outcome = await ensure(online);
                    } catch (error: any) {
                        if (!online) throw error;
                        // Some servers refuse an online build for a particular table; build it normally.
                        console.warn(`[PerformanceIndexes] ${index.name}: online build failed (${error.message}), building offline`);
                        outcome = await ensure(false);
                    }
                    if (outcome === "created") {
                        created.push(index.name);
                        console.log(`[PerformanceIndexes] Created ${index.name} in ${Date.now() - started} ms`);
                    } else if (outcome.startsWith("skipped")) {
                        console.warn(`[PerformanceIndexes] ${index.name} ${outcome}`);
                    }
                } catch (error: any) {
                    failed.push(index.name);
                    console.error(`[PerformanceIndexes] ${index.name} failed: ${error.message}`);
                }
            }
            console.log(`[PerformanceIndexes] Done: ${created.length} created, ${failed.length} failed, ${PERFORMANCE_INDEXES.length - created.length - failed.length} already present or skipped`);
        } catch (error: any) {
            console.error(`[PerformanceIndexes] Could not check indexes: ${error.message}`);
        } finally {
            await pool?.close().catch(() => undefined);
        }
    }
}
