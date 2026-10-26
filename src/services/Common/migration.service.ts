import { AppDataSource } from "../../config/database.js";
import { abdmConfig } from "../../config/abdm.config.js";

export class MigrationService {
    static async ensureLogIndexes() {
        try {
            console.log("Checking APILog indexes...");
            const queries = [
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_APILogs_RequestedOn' AND object_id = OBJECT_ID('APILogs')) CREATE INDEX IX_APILogs_RequestedOn ON APILogs (RequestedOn DESC);",
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_APILogs_LogId_DESC' AND object_id = OBJECT_ID('APILogs')) CREATE INDEX IX_APILogs_LogId_DESC ON APILogs (LogId DESC);",
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_APILogs_Method' AND object_id = OBJECT_ID('APILogs')) CREATE INDEX IX_APILogs_Method ON APILogs (Method);",
                
                // Consent Request Schema Updates
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ConsentRequests') AND name = 'SignedPdfUrl') ALTER TABLE ConsentRequests ADD SignedPdfUrl NVARCHAR(MAX) NULL;",
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ConsentRequests') AND name = 'SignatureImageUrl') ALTER TABLE ConsentRequests ADD SignatureImageUrl NVARCHAR(MAX) NULL;",

                // Consent Template Fields Schema Updates
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ConsentTemplateFields') AND name = 'FieldKey') ALTER TABLE ConsentTemplateFields ADD FieldKey NVARCHAR(100) NULL;",

                // Password Reset Tokens Table
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PasswordResetTokens')
                CREATE TABLE PasswordResetTokens (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    UserId UNIQUEIDENTIFIER NOT NULL,
                    Token VARCHAR(500) NOT NULL,
                    ExpiryTime DATETIME NOT NULL,
                    IsUsed BIT DEFAULT 0,
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UsedAt DATETIME NULL,
                    CONSTRAINT FK_PasswordResetTokens_Users FOREIGN KEY (UserId) REFERENCES Users(Id)
                );`,

                // Patient Access Consents Table (Doctor Medical Record Access Permissions)
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PatientAccessConsents')
                CREATE TABLE PatientAccessConsents (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    PatientId UNIQUEIDENTIFIER NOT NULL,
                    DoctorId UNIQUEIDENTIFIER NOT NULL,
                    HospitalId INT NULL,
                    OrganizationId INT NULL,
                    Duration NVARCHAR(50) NOT NULL,
                    DurationMinutes INT NOT NULL DEFAULT 60,
                    Status NVARCHAR(50) NOT NULL DEFAULT 'PENDING',
                    RequestedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    ApprovedAt DATETIME NULL,
                    ExpiresAt DATETIME NULL,
                    Notes NVARCHAR(500) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UpdatedAt DATETIME DEFAULT GETDATE()
                );`,

                // Seed default AppVersions if not existing
                `IF NOT EXISTS (SELECT * FROM AppVersions WHERE Platform = 'android')
                INSERT INTO AppVersions (Platform, Version, MinVersion, ForceUpdate, Url, IsLatest, IsDeleted, CreatedAt, Maintenance, Logout)
                VALUES ('android', '1.0.0', '1.0.0', 0, 'https://play.google.com/store/apps/details?id=ai.yira.clinicx', 1, 0, GETDATE(), 0, 0);`,

                `IF NOT EXISTS (SELECT * FROM AppVersions WHERE Platform = 'ios')
                INSERT INTO AppVersions (Platform, Version, MinVersion, ForceUpdate, Url, IsLatest, IsDeleted, CreatedAt, Maintenance, Logout)
                VALUES ('ios', '1.0.0', '1.0.0', 0, 'https://apps.apple.com/app/yira-clinx/id6741477759', 1, 0, GETDATE(), 0, 0);`
            ];

            for (const query of queries) {
                await AppDataSource.query(query);
            }
            console.log("APILog indexes guaranteed.");
        } catch (error) {
            console.error("Failed to ensure log indexes:", error);
        }
    }

    /**
     * ABDM (ABHA) schema. The User and PatientRegistration entities map these columns, so a failure
     * here stops startup rather than leaving every patient query broken.
     */
    static async ensureAbdmSchema() {
        const statements = [
            // ABHA number and preferred ABHA address beside the patient's other identifiers
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'AbhaNumber') ALTER TABLE Users ADD AbhaNumber VARCHAR(17) NULL;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'AbhaAddress') ALTER TABLE Users ADD AbhaAddress VARCHAR(100) NULL;",
            "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'AbhaLinkedAt') ALTER TABLE Users ADD AbhaLinkedAt DATETIME NULL;",

            // The person has come through ABHA somewhere (verified at a desk, or shared by Scan and Share).
            // Added with a one-time backfill: every ABHA linked before the column existed came through that step.
            `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Users') AND name = 'RegisteredViaAbha')
            BEGIN
                ALTER TABLE Users ADD RegisteredViaAbha BIT NOT NULL CONSTRAINT DF_Users_RegisteredViaAbha DEFAULT 0;
                EXEC('UPDATE Users SET RegisteredViaAbha = 1 WHERE AbhaNumber IS NOT NULL');
            END`,

            // Registered through ABHA at this hospital: what a hospital's "From ABHA" patient filter reads.
            `IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('PatientRegistrations') AND name = 'RegisteredViaAbha')
            BEGIN
                ALTER TABLE PatientRegistrations ADD RegisteredViaAbha BIT NOT NULL CONSTRAINT DF_PatientRegistrations_RegisteredViaAbha DEFAULT 0;
                EXEC('UPDATE pr SET RegisteredViaAbha = 1 FROM PatientRegistrations pr INNER JOIN Users u ON u.Id = pr.UserId WHERE u.AbhaNumber IS NOT NULL');
            END`,

            // One ABHA number links to one patient record
            `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_Users_AbhaNumber' AND object_id = OBJECT_ID('Users'))
            EXEC('CREATE UNIQUE NONCLUSTERED INDEX UX_Users_AbhaNumber ON Users (AbhaNumber) WHERE AbhaNumber IS NOT NULL AND IsDeleted = 0');`,

            // Who agreed to ABHA creation, who confirmed it at the desk, and when (no Aadhaar is stored)
            `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AbhaConsents')
            CREATE TABLE AbhaConsents (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                ConsentCode VARCHAR(50) NOT NULL,
                ConsentVersion VARCHAR(10) NOT NULL,
                Declarations NVARCHAR(MAX) NOT NULL,
                StaffUserId UNIQUEIDENTIFIER NOT NULL,
                StaffName NVARCHAR(200) NULL,
                BeneficiaryName NVARCHAR(200) NULL,
                HospitalId INT NULL,
                OrganizationId INT NULL,
                TxnId VARCHAR(64) NULL,
                AbhaNumber VARCHAR(17) NULL,
                PatientUserId UNIQUEIDENTIFIER NULL,
                AgreedAt DATETIME NOT NULL,
                CreatedAt DATETIME NOT NULL DEFAULT GETDATE()
            );`,

            // Scan and Share: each profile a patient shared at a counter, and the queue token sent back
            `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AbhaProfileShares')
            CREATE TABLE AbhaProfileShares (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                RequestId VARCHAR(64) NOT NULL,
                HipId VARCHAR(50) NOT NULL,
                CounterId VARCHAR(20) NOT NULL,
                AbhaNumber VARCHAR(17) NULL,
                AbhaAddress VARCHAR(100) NOT NULL,
                PatientName NVARCHAR(200) NULL,
                UserId UNIQUEIDENTIFIER NULL,
                HospitalId INT NULL,
                TokenNumber VARCHAR(20) NULL,
                ExpiresAt DATETIME NULL,
                Status VARCHAR(20) NOT NULL,
                MatchType VARCHAR(20) NULL,
                Error NVARCHAR(500) NULL,
                CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                UpdatedAt DATETIME NULL
            );`,
            // A share ABDM retries is processed once
            `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_AbhaProfileShares_RequestId' AND object_id = OBJECT_ID('AbhaProfileShares'))
            CREATE UNIQUE INDEX UX_AbhaProfileShares_RequestId ON AbhaProfileShares (RequestId);`,
            `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_AbhaProfileShares_Queue' AND object_id = OBJECT_ID('AbhaProfileShares'))
            CREATE INDEX IX_AbhaProfileShares_Queue ON AbhaProfileShares (HospitalId, CounterId, CreatedAt DESC);`,
        ];

        for (const statement of statements) {
            try {
                await AppDataSource.query(statement);
            } catch (error: any) {
                throw new Error(`ABDM schema migration failed (${statement.trim().split("\n")[0]!.slice(0, 120)}): ${error?.message}`);
            }
        }
        console.log("ABDM schema guaranteed.");
    }

    /**
     * ABDM Milestone 3 (ClinicX as a Health Information User): the five AbdmHiu* tables, their
     * indexes, and the "ABDM Record Request" menu for the roles in ABDM_HIU_ROLE_NAMES (plan
     * section 5, decision D9). Idempotent: a table is created when missing, then every column is
     * added behind its own COL_LENGTH guard, so a table created by an earlier version gains later
     * columns. Fails startup on error, like ensureAbdmSchema(). Never drops or alters an existing column.
     */
    static async ensureAbdmHiuSchema() {
        const run = async (statement: string, params: unknown[] = []) => {
            try {
                return await AppDataSource.query(statement, params);
            } catch (error: any) {
                throw new Error(`ABDM HIU schema migration failed (${statement.trim().split("\n")[0]!.slice(0, 120)}): ${error?.message}`);
            }
        };

        for (const table of ABDM_HIU_TABLES) {
            const columns = table.columns.map(([name, definition]) => `${name} ${definition}`).join(",\n                ");
            await run(`IF OBJECT_ID(N'dbo.${table.name}', N'U') IS NULL
            CREATE TABLE dbo.${table.name} (
                Id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_${table.name} PRIMARY KEY,
                ${columns}
            );`);
            // One batch of column guards, then (once those columns exist) one batch of index guards,
            // so startup makes a handful of round trips rather than one per column.
            await run(table.columns
                .map(([name, definition]) => `IF COL_LENGTH('dbo.${table.name}', '${name}') IS NULL ALTER TABLE dbo.${table.name} ADD ${name} ${definition};`)
                .join("\n"));
            await run(table.indexes
                .map((index) => `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${index.name}' AND object_id = OBJECT_ID('dbo.${table.name}'))
            CREATE ${index.unique ? "UNIQUE " : ""}NONCLUSTERED INDEX ${index.name} ON dbo.${table.name} (${index.on})${index.where ? ` WHERE ${index.where}` : ""};`)
                .join("\n"));
        }

        // The sidebar item (D9). A high OrderNo keeps it last, so it never becomes a landing page.
        // Inserted only when no row has its route, so an admin's later edit or deactivation stands.
        await run(`IF NOT EXISTS (SELECT 1 FROM SidebarMenus WHERE Route = @0)
            INSERT INTO SidebarMenus (MenuName, Route, Icon, ImagePath, UseImage, ParentMenuId, OrderNo, Status, CreatedAt)
            VALUES (@1, @0, @2, NULL, 0, NULL, @3, 1, GETDATE());`,
            [ABDM_HIU_MENU.route, ABDM_HIU_MENU.name, ABDM_HIU_MENU.icon, ABDM_HIU_MENU.orderNo]);

        // A global (no organization, no hospital) assignment per allowed role, only where none exists,
        // active or not: an admin who switched it off is not overridden.
        for (const roleName of abdmConfig.hiuRoleNames) {
            const matched = await run(`SELECT COUNT(*) AS Matches FROM Roles WHERE UPPER(LTRIM(RTRIM(RoleName))) = UPPER(@0) OR UPPER(NormalizedName) = UPPER(@0);`, [roleName]);
            if (!Number(matched?.[0]?.Matches)) {
                console.warn(`ABDM HIU menu: no role is named "${roleName.slice(0, 60)}" (ABDM_HIU_ROLE_NAMES); nothing assigned for it.`);
                continue;
            }
            await run(`INSERT INTO RoleSidebarMenus (RoleId, MenuId, OrganizationId, HospitalId, Status, CreatedAt)
            SELECT r.Id, m.MenuId, NULL, NULL, 1, GETDATE()
            FROM Roles r
            CROSS JOIN (SELECT TOP 1 MenuId FROM SidebarMenus WHERE Route = @1 ORDER BY MenuId) m
            WHERE (UPPER(LTRIM(RTRIM(r.RoleName))) = UPPER(@0) OR UPPER(r.NormalizedName) = UPPER(@0))
              AND NOT EXISTS (
                SELECT 1 FROM RoleSidebarMenus x
                WHERE x.RoleId = r.Id AND x.MenuId = m.MenuId AND x.OrganizationId IS NULL AND x.HospitalId IS NULL
              );`, [roleName, ABDM_HIU_MENU.route]);
        }
        console.log("ABDM HIU schema guaranteed.");
    }
}

/** The staff page's sidebar item (D9). */
export const ABDM_HIU_MENU = { name: "ABDM Record Request", route: "/abdm/record-request", icon: "FileSearch", orderNo: 900 } as const;

interface HiuTableSpec {
    name: string;
    /** [column, definition]. Every column, so CREATE and the per-column guards never drift apart. */
    columns: [string, string][];
    indexes: { name: string; on: string; unique?: boolean; where?: string }[];
}

/** The M3 tables (plan section 5). Names are prefixed AbdmHiu, apart from ClinicX's other consent tables. */
const ABDM_HIU_TABLES: HiuTableSpec[] = [
    {
        name: "AbdmHiuConsentRequests",
        columns: [
            ["InitRequestId", "VARCHAR(64) NOT NULL"],
            ["ConsentRequestId", "VARCHAR(64) NULL"],
            ["StatusRequestId", "VARCHAR(64) NULL"],
            ["HospitalId", "INT NOT NULL"],
            ["OrganizationId", "INT NULL"],
            ["StaffUserId", "UNIQUEIDENTIFIER NOT NULL"],
            ["StaffName", "NVARCHAR(200) NULL"],
            ["PatientUserId", "UNIQUEIDENTIFIER NOT NULL"],
            ["AbhaAddress", "VARCHAR(100) NOT NULL"],
            ["PurposeCode", "VARCHAR(10) NOT NULL"],
            ["HiTypes", "NVARCHAR(400) NOT NULL"],
            ["DateFrom", "DATETIME2(3) NOT NULL"],
            ["DateTo", "DATETIME2(3) NOT NULL"],
            ["DataEraseAt", "DATETIME2(3) NOT NULL"],
            ["AccessMode", "VARCHAR(10) NOT NULL"],
            ["Status", "VARCHAR(20) NOT NULL"],
            ["StatusAt", "DATETIME2(3) NOT NULL"],
            ["AbdmErrorCode", "VARCHAR(20) NULL"],
            ["AbdmError", "NVARCHAR(500) NULL"],
            ["CreatedAt", "DATETIME2(3) NOT NULL CONSTRAINT DF_AbdmHiuConsentRequests_CreatedAt DEFAULT GETDATE()"],
            ["UpdatedAt", "DATETIME2(3) NULL"],
        ],
        indexes: [
            { name: "UX_AbdmHiuConsentRequests_InitRequestId", on: "InitRequestId", unique: true },
            { name: "UX_AbdmHiuConsentRequests_ConsentRequestId", on: "ConsentRequestId", unique: true, where: "ConsentRequestId IS NOT NULL" },
            { name: "IX_AbdmHiuConsentRequests_StatusRequestId", on: "StatusRequestId", where: "StatusRequestId IS NOT NULL" },
            { name: "IX_AbdmHiuConsentRequests_Hospital", on: "HospitalId, CreatedAt DESC" },
            { name: "IX_AbdmHiuConsentRequests_Patient", on: "HospitalId, PatientUserId, Status" },
        ],
    },
    {
        name: "AbdmHiuConsentArtefacts",
        columns: [
            ["ConsentArtefactId", "VARCHAR(64) NOT NULL"],
            ["ConsentRequestFk", "INT NOT NULL"],
            ["HospitalId", "INT NOT NULL"],
            ["HipId", "VARCHAR(50) NULL"],
            ["HipName", "NVARCHAR(200) NULL"],
            ["Status", "VARCHAR(20) NOT NULL"],
            ["StatusAt", "DATETIME2(3) NOT NULL"],
            ["HiTypes", "NVARCHAR(400) NULL"],
            ["DateFrom", "DATETIME2(3) NULL"],
            ["DateTo", "DATETIME2(3) NULL"],
            ["DataEraseAt", "DATETIME2(3) NULL"],
            ["AccessMode", "VARCHAR(10) NULL"],
            ["Frequency", "NVARCHAR(200) NULL"],
            ["CareContexts", "VARCHAR(MAX) NULL"],
            ["Signature", "VARCHAR(MAX) NULL"],
            ["FetchRequestId", "VARCHAR(64) NULL"],
            ["FetchedAt", "DATETIME2(3) NULL"],
            ["FetchAttempts", "INT NOT NULL CONSTRAINT DF_AbdmHiuConsentArtefacts_FetchAttempts DEFAULT 0"],
            ["RecordsPurgedAt", "DATETIME2(3) NULL"],
            ["CreatedAt", "DATETIME2(3) NOT NULL CONSTRAINT DF_AbdmHiuConsentArtefacts_CreatedAt DEFAULT GETDATE()"],
            ["UpdatedAt", "DATETIME2(3) NULL"],
        ],
        indexes: [
            { name: "UX_AbdmHiuConsentArtefacts_ConsentArtefactId", on: "ConsentArtefactId", unique: true },
            { name: "IX_AbdmHiuConsentArtefacts_ConsentRequestFk", on: "ConsentRequestFk" },
            { name: "IX_AbdmHiuConsentArtefacts_FetchRequestId", on: "FetchRequestId", where: "FetchRequestId IS NOT NULL" },
            { name: "IX_AbdmHiuConsentArtefacts_Status_DataEraseAt", on: "Status, DataEraseAt" },
        ],
    },
    {
        name: "AbdmHiuDataRequests",
        columns: [
            ["HiRequestId", "VARCHAR(64) NOT NULL"],
            ["TransactionId", "VARCHAR(64) NULL"],
            ["ArtefactFk", "INT NOT NULL"],
            ["HospitalId", "INT NOT NULL"],
            ["DateFrom", "DATETIME2(3) NOT NULL"],
            ["DateTo", "DATETIME2(3) NOT NULL"],
            ["PushTokenHash", "CHAR(64) NOT NULL"],
            ["PrivateKey", "VARCHAR(2000) NULL"],
            ["Nonce", "VARCHAR(100) NULL"],
            ["KeyExpiresAt", "DATETIME2(3) NOT NULL"],
            ["TransferDeadline", "DATETIME2(3) NULL"],
            ["SessionStatus", "VARCHAR(20) NOT NULL"],
            ["PageCount", "INT NULL"],
            ["PagesReceived", "INT NOT NULL CONSTRAINT DF_AbdmHiuDataRequests_PagesReceived DEFAULT 0"],
            ["BytesReceived", "BIGINT NOT NULL CONSTRAINT DF_AbdmHiuDataRequests_BytesReceived DEFAULT 0"],
            ["CareContextStatus", "VARCHAR(MAX) NULL"],
            ["NotifiedAt", "DATETIME2(3) NULL"],
            ["NotifyRequestId", "VARCHAR(64) NULL"],
            ["Error", "NVARCHAR(500) NULL"],
            ["CreatedAt", "DATETIME2(3) NOT NULL CONSTRAINT DF_AbdmHiuDataRequests_CreatedAt DEFAULT GETDATE()"],
            ["CompletedAt", "DATETIME2(3) NULL"],
        ],
        indexes: [
            { name: "UX_AbdmHiuDataRequests_HiRequestId", on: "HiRequestId", unique: true },
            { name: "UX_AbdmHiuDataRequests_TransactionId", on: "TransactionId", unique: true, where: "TransactionId IS NOT NULL" },
            { name: "UX_AbdmHiuDataRequests_PushTokenHash", on: "PushTokenHash", unique: true },
            { name: "IX_AbdmHiuDataRequests_ArtefactFk", on: "ArtefactFk" },
            // At most one open transfer per artefact, even when two requests race past the open check.
            { name: "UX_AbdmHiuDataRequests_OpenArtefact", on: "ArtefactFk", unique: true, where: "SessionStatus IN ('REQUESTED', 'RECEIVING')" },
            { name: "IX_AbdmHiuDataRequests_SessionStatus_KeyExpiresAt", on: "SessionStatus, KeyExpiresAt" },
        ],
    },
    {
        name: "AbdmHiuRecords",
        columns: [
            ["DataRequestFk", "INT NOT NULL"],
            ["ArtefactFk", "INT NOT NULL"],
            ["HospitalId", "INT NOT NULL"],
            ["PageNumber", "INT NOT NULL"],
            ["EntryIndex", "INT NOT NULL"],
            ["CareContextReference", "VARCHAR(1000) NULL"],
            ["Media", "VARCHAR(100) NULL"],
            ["ChecksumOk", "BIT NOT NULL CONSTRAINT DF_AbdmHiuRecords_ChecksumOk DEFAULT 0"],
            ["Content", "NVARCHAR(MAX) NULL"],
            ["DeleteAt", "DATETIME2(3) NULL"],
            ["ReceivedAt", "DATETIME2(3) NOT NULL CONSTRAINT DF_AbdmHiuRecords_ReceivedAt DEFAULT GETDATE()"],
        ],
        indexes: [
            { name: "UX_AbdmHiuRecords_Page_Entry", on: "DataRequestFk, PageNumber, EntryIndex", unique: true },
            { name: "IX_AbdmHiuRecords_ArtefactFk", on: "ArtefactFk" },
            { name: "IX_AbdmHiuRecords_DeleteAt", on: "DeleteAt" },
        ],
    },
    {
        name: "AbdmHiuAuditEvents",
        columns: [
            ["At", "DATETIME2(3) NOT NULL CONSTRAINT DF_AbdmHiuAuditEvents_At DEFAULT GETDATE()"],
            ["HospitalId", "INT NULL"],
            ["StaffUserId", "UNIQUEIDENTIFIER NULL"],
            ["Event", "VARCHAR(50) NOT NULL"],
            ["ConsentRequestId", "VARCHAR(64) NULL"],
            ["ArtefactId", "VARCHAR(64) NULL"],
            ["TransactionId", "VARCHAR(64) NULL"],
            ["RequestId", "VARCHAR(64) NULL"],
            ["Outcome", "VARCHAR(50) NOT NULL"],
            ["Detail", "NVARCHAR(500) NULL"],
        ],
        indexes: [
            { name: "IX_AbdmHiuAuditEvents_ConsentRequestId", on: "ConsentRequestId, At", where: "ConsentRequestId IS NOT NULL" },
            { name: "IX_AbdmHiuAuditEvents_Hospital", on: "HospitalId, At DESC" },
        ],
    },
];
