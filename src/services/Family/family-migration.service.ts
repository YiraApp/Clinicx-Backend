import { AppDataSource } from "../../config/database.js";

/**
 * Tables for linking existing Yira accounts into one family (family codes,
 * link requests and accepted links). Every statement is idempotent and runs
 * on its own at startup, so one failure doesn't skip the rest. The same SQL is
 * kept in reports/sql/family-links.sql for running by hand.
 *
 * Times are written by the app as India clock time (the driver runs with
 * useUTC: false), so the defaults use the same clock. The app always sets the
 * times it compares; the defaults only cover rows written by hand.
 */
export const FAMILY_LINK_MIGRATION_SQL: string[] = [
    `IF OBJECT_ID(N'dbo.FamilyLinks', N'U') IS NULL
    CREATE TABLE dbo.FamilyLinks (
        Id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_FamilyLinks PRIMARY KEY,
        RequesterUserId UNIQUEIDENTIFIER NOT NULL,
        TargetUserId UNIQUEIDENTIFIER NOT NULL,
        Relation NVARCHAR(50) NOT NULL,
        TargetRelation NVARCHAR(50) NULL,
        Status VARCHAR(20) NOT NULL CONSTRAINT DF_FamilyLinks_Status DEFAULT 'PENDING',
        Method VARCHAR(10) NOT NULL,
        ExpiresAt DATETIME NULL,
        RespondedAt DATETIME NULL,
        LinkedAt DATETIME NULL,
        RemovedAt DATETIME NULL,
        RemovedByUserId UNIQUEIDENTIFIER NULL,
        CreatedAt DATETIME NOT NULL CONSTRAINT DF_FamilyLinks_CreatedAt DEFAULT DATEADD(MINUTE, 330, GETUTCDATE()),
        UpdatedAt DATETIME NOT NULL CONSTRAINT DF_FamilyLinks_UpdatedAt DEFAULT DATEADD(MINUTE, 330, GETUTCDATE()),
        CONSTRAINT CK_FamilyLinks_NotSelf CHECK (RequesterUserId <> TargetUserId)
    );`,
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_FamilyLinks_Requester_Status' AND object_id = OBJECT_ID(N'dbo.FamilyLinks'))
    CREATE INDEX IX_FamilyLinks_Requester_Status ON dbo.FamilyLinks (RequesterUserId, Status) INCLUDE (TargetUserId);`,
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_FamilyLinks_Target_Status' AND object_id = OBJECT_ID(N'dbo.FamilyLinks'))
    CREATE INDEX IX_FamilyLinks_Target_Status ON dbo.FamilyLinks (TargetUserId, Status) INCLUDE (RequesterUserId);`,

    `IF OBJECT_ID(N'dbo.FamilyCodes', N'U') IS NULL
    CREATE TABLE dbo.FamilyCodes (
        Id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_FamilyCodes PRIMARY KEY,
        UserId UNIQUEIDENTIFIER NOT NULL,
        CodeSeed VARCHAR(64) NOT NULL,
        ExpiresAt DATETIME NOT NULL,
        RevokedAt DATETIME NULL,
        FailedAttempts INT NOT NULL CONSTRAINT DF_FamilyCodes_FailedAttempts DEFAULT 0,
        CreatedAt DATETIME NOT NULL CONSTRAINT DF_FamilyCodes_CreatedAt DEFAULT DATEADD(MINUTE, 330, GETUTCDATE())
    );`,
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_FamilyCodes_UserId' AND object_id = OBJECT_ID(N'dbo.FamilyCodes'))
    CREATE INDEX IX_FamilyCodes_UserId ON dbo.FamilyCodes (UserId, Id DESC) INCLUDE (ExpiresAt, RevokedAt);`,

    `IF OBJECT_ID(N'dbo.FamilyLinkAttempts', N'U') IS NULL
    CREATE TABLE dbo.FamilyLinkAttempts (
        Id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_FamilyLinkAttempts PRIMARY KEY,
        RequesterUserId UNIQUEIDENTIFIER NOT NULL,
        TargetUserId UNIQUEIDENTIFIER NULL,
        Kind VARCHAR(10) NOT NULL,
        Success BIT NOT NULL,
        CreatedAt DATETIME NOT NULL CONSTRAINT DF_FamilyLinkAttempts_CreatedAt DEFAULT DATEADD(MINUTE, 330, GETUTCDATE())
    );`,
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_FamilyLinkAttempts_Requester' AND object_id = OBJECT_ID(N'dbo.FamilyLinkAttempts'))
    CREATE INDEX IX_FamilyLinkAttempts_Requester ON dbo.FamilyLinkAttempts (RequesterUserId, Kind, CreatedAt) INCLUDE (Success);`,
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_FamilyLinkAttempts_Target' AND object_id = OBJECT_ID(N'dbo.FamilyLinkAttempts'))
    CREATE INDEX IX_FamilyLinkAttempts_Target ON dbo.FamilyLinkAttempts (TargetUserId, Kind, CreatedAt) INCLUDE (Success);`,
];

export class FamilyMigrationService {
    static async run(): Promise<void> {
        for (const sql of FAMILY_LINK_MIGRATION_SQL) {
            try {
                await AppDataSource.query(sql);
            } catch (error: any) {
                const name = /(?:TABLE|INDEX)\s+(?:dbo\.)?(\w+)/i.exec(sql)?.[1] ?? "statement";
                console.error(`[FamilyMigration] ${name}: ${error?.message}`);
            }
        }
    }
}
