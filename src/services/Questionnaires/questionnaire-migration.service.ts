import { AppDataSource } from "../../config/database.js";

/** The input kinds the apps know how to show. A type's behaviour is fixed by its code. */
export const QUESTION_TYPES = [
    { code: "SHORT_TEXT", name: "Short text", hasOptions: false, order: 1 },
    { code: "LONG_TEXT", name: "Long text", hasOptions: false, order: 2 },
    { code: "NUMBER", name: "Number", hasOptions: false, order: 3 },
    { code: "SINGLE_CHOICE", name: "Single choice", hasOptions: true, order: 4 },
    { code: "MULTI_CHOICE", name: "Multiple choice", hasOptions: true, order: 5 },
    { code: "DROPDOWN", name: "Dropdown", hasOptions: true, order: 6 },
    { code: "YES_NO", name: "Yes / No", hasOptions: false, order: 7 },
    { code: "DATE", name: "Date", hasOptions: false, order: 8 },
    { code: "RATING", name: "Rating (1-5)", hasOptions: false, order: 9 },
] as const;

export type QuestionTypeCode = (typeof QUESTION_TYPES)[number]["code"];

const audit = `
    IsDeleted BIT NOT NULL DEFAULT 0,
    CreatedBy UNIQUEIDENTIFIER NULL,
    CreatedAt DATETIME NOT NULL DEFAULT DATEADD(MINUTE, 330, GETUTCDATE()),
    UpdatedAt DATETIME NOT NULL DEFAULT DATEADD(MINUTE, 330, GETUTCDATE())`;

const TABLES: Array<[string, string]> = [
    ["QuestionTypes", `
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Code NVARCHAR(40) NOT NULL UNIQUE,
        Name NVARCHAR(100) NOT NULL,
        HasOptions BIT NOT NULL DEFAULT 0,
        OrderNo INT NOT NULL DEFAULT 0,
        IsActive BIT NOT NULL DEFAULT 1,
        CreatedAt DATETIME NOT NULL DEFAULT DATEADD(MINUTE, 330, GETUTCDATE()),
        UpdatedAt DATETIME NOT NULL DEFAULT DATEADD(MINUTE, 330, GETUTCDATE())`],
    ["QuestionnaireCategories", `
        Id INT IDENTITY(1,1) PRIMARY KEY,
        HospitalId INT NOT NULL,
        OrganizationId INT NULL,
        Name NVARCHAR(150) NOT NULL,
        Description NVARCHAR(500) NULL,
        IsActive BIT NOT NULL DEFAULT 1,${audit}`],
    ["QuestionnaireQuestions", `
        Id INT IDENTITY(1,1) PRIMARY KEY,
        HospitalId INT NOT NULL,
        OrganizationId INT NULL,
        CategoryId INT NULL,
        QuestionTypeId INT NOT NULL,
        Text NVARCHAR(1000) NOT NULL,
        HelpText NVARCHAR(1000) NULL,
        IsRequired BIT NOT NULL DEFAULT 0,
        MinValue FLOAT NULL,
        MaxValue FLOAT NULL,
        IsActive BIT NOT NULL DEFAULT 1,${audit}`],
    ["QuestionnaireQuestionOptions", `
        Id INT IDENTITY(1,1) PRIMARY KEY,
        QuestionId INT NOT NULL,
        Label NVARCHAR(500) NOT NULL,
        OrderNo INT NOT NULL DEFAULT 0,
        IsActive BIT NOT NULL DEFAULT 1,${audit}`],
    ["Questionnaires", `
        Id INT IDENTITY(1,1) PRIMARY KEY,
        HospitalId INT NOT NULL,
        OrganizationId INT NULL,
        CategoryId INT NULL,
        Title NVARCHAR(200) NOT NULL,
        Description NVARCHAR(2000) NULL,
        TargetGender NVARCHAR(10) NOT NULL DEFAULT 'All',
        AllowMultiple BIT NOT NULL DEFAULT 1,
        RepeatAfterDays INT NULL,
        Status NVARCHAR(20) NOT NULL DEFAULT 'Draft',
        PublishedAt DATETIME NULL,${audit}`],
    ["QuestionnaireItems", `
        Id INT IDENTITY(1,1) PRIMARY KEY,
        QuestionnaireId INT NOT NULL,
        QuestionId INT NOT NULL,
        OrderNo INT NOT NULL DEFAULT 0,
        IsRequired BIT NOT NULL DEFAULT 0,${audit}`],
    ["QuestionnaireAssignments", `
        Id INT IDENTITY(1,1) PRIMARY KEY,
        QuestionnaireId INT NOT NULL,
        HospitalId INT NOT NULL,
        OrganizationId INT NULL,
        PatientUserId UNIQUEIDENTIFIER NOT NULL,
        SentAt DATETIME NOT NULL DEFAULT DATEADD(MINUTE, 330, GETUTCDATE()),
        SentBy UNIQUEIDENTIFIER NULL,
        DueAt DATETIME NULL,
        Source NVARCHAR(20) NOT NULL DEFAULT 'Manual',
        Status NVARCHAR(20) NOT NULL DEFAULT 'Pending',
        SubmissionId INT NULL,${audit}`],
    ["QuestionnaireSubmissions", `
        Id INT IDENTITY(1,1) PRIMARY KEY,
        QuestionnaireId INT NOT NULL,
        HospitalId INT NOT NULL,
        OrganizationId INT NULL,
        PatientUserId UNIQUEIDENTIFIER NOT NULL,
        AssignmentId INT NULL,
        AttemptNo INT NOT NULL DEFAULT 1,
        PatientGender NVARCHAR(10) NULL,
        SubmittedAt DATETIME NOT NULL DEFAULT DATEADD(MINUTE, 330, GETUTCDATE()),
        SubmittedBy UNIQUEIDENTIFIER NULL,${audit}`],
    ["QuestionnaireAnswers", `
        Id INT IDENTITY(1,1) PRIMARY KEY,
        SubmissionId INT NOT NULL,
        QuestionId INT NOT NULL,
        QuestionText NVARCHAR(1000) NOT NULL,
        TypeCode NVARCHAR(40) NOT NULL,
        OptionIds NVARCHAR(500) NULL,
        OptionLabels NVARCHAR(MAX) NULL,
        TextValue NVARCHAR(MAX) NULL,
        NumberValue FLOAT NULL,
        DateValue DATE NULL,
        CreatedAt DATETIME NOT NULL DEFAULT DATEADD(MINUTE, 330, GETUTCDATE())`],
    ["QuestionnaireInsights", `
        Id INT IDENTITY(1,1) PRIMARY KEY,
        HospitalId INT NOT NULL,
        QuestionnaireId INT NULL,
        FromDate DATE NULL,
        ToDate DATE NULL,
        ResultJson NVARCHAR(MAX) NOT NULL,
        CreatedBy UNIQUEIDENTIFIER NULL,
        CreatedAt DATETIME NOT NULL DEFAULT DATEADD(MINUTE, 330, GETUTCDATE())`],
];

const INDEXES: Array<[string, string, string]> = [
    ["IX_QCategories_Hospital", "QuestionnaireCategories", "(HospitalId, IsDeleted)"],
    ["IX_QQuestions_Hospital", "QuestionnaireQuestions", "(HospitalId, IsDeleted, CategoryId)"],
    ["IX_QOptions_Question", "QuestionnaireQuestionOptions", "(QuestionId, IsDeleted)"],
    ["IX_Questionnaires_Hospital", "Questionnaires", "(HospitalId, Status, IsDeleted)"],
    ["IX_QItems_Questionnaire", "QuestionnaireItems", "(QuestionnaireId, IsDeleted)"],
    ["IX_QAssignments_Patient", "QuestionnaireAssignments", "(PatientUserId, Status, IsDeleted)"],
    ["IX_QAssignments_Questionnaire", "QuestionnaireAssignments", "(QuestionnaireId, Status, IsDeleted)"],
    ["IX_QSubmissions_Patient", "QuestionnaireSubmissions", "(PatientUserId, QuestionnaireId, IsDeleted)"],
    ["IX_QSubmissions_Hospital", "QuestionnaireSubmissions", "(HospitalId, SubmittedAt, IsDeleted)"],
    ["IX_QAnswers_Submission", "QuestionnaireAnswers", "(SubmissionId)"],
    ["IX_QAnswers_Question", "QuestionnaireAnswers", "(QuestionId)"],
];

export class QuestionnaireMigrationService {
    /** Creates the questionnaire tables if they are missing and seeds the question types. Touches nothing else. */
    static async run(): Promise<void> {
        // Each statement runs on its own, so one failure doesn't skip the rest.
        for (const [name, columns] of TABLES) {
            try {
                await AppDataSource.query(
                    `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${name}') BEGIN CREATE TABLE ${name} (${columns}); END;`
                );
            } catch (error: any) {
                console.error(`[QuestionnaireMigration] ${name}: ${error.message}`);
            }
        }
        for (const [index, table, columns] of INDEXES) {
            try {
                await AppDataSource.query(
                    `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = '${index}' AND object_id = OBJECT_ID('${table}'))
                     BEGIN CREATE INDEX ${index} ON ${table} ${columns}; END;`
                );
            } catch (error: any) {
                console.error(`[QuestionnaireMigration] ${index}: ${error.message}`);
            }
        }
        await QuestionnaireMigrationService.useIndiaTimeDefaults();
        for (const type of QUESTION_TYPES) {
            try {
                await AppDataSource.query(
                    `IF NOT EXISTS (SELECT 1 FROM QuestionTypes WHERE Code = @0)
                     INSERT INTO QuestionTypes (Code, Name, HasOptions, OrderNo) VALUES (@0, @1, @2, @3)`,
                    [type.code, type.name, type.hasOptions ? 1 : 0, type.order]
                );
            } catch (error: any) {
                console.error(`[QuestionnaireMigration] seed ${type.code}: ${error.message}`);
            }
        }
    }

    /**
     * The app stores times as India clock time (the driver runs with useUTC: false and the server
     * with TZ=Asia/Kolkata), but Azure SQL's GETDATE() is UTC. Tables created before this fix have
     * DEFAULT GETDATE() on their date columns, which put new rows 5.5 hours in the past; this swaps
     * those defaults for India time. Only the questionnaire tables are touched; it does nothing
     * once they are fixed.
     */
    private static async useIndiaTimeDefaults(): Promise<void> {
        const tables = TABLES.map(([name]) => `'${name}'`).join(", ");
        let rows: Array<{ TableName: string; ColumnName: string; ConstraintName: string }> = [];
        try {
            rows = await AppDataSource.query(
                `SELECT t.name AS TableName, c.name AS ColumnName, dc.name AS ConstraintName
                 FROM sys.default_constraints dc
                 JOIN sys.tables t ON t.object_id = dc.parent_object_id
                 JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
                 WHERE t.name IN (${tables})
                   AND LOWER(REPLACE(REPLACE(dc.definition, '(', ''), ')', '')) = 'getdate'`
            );
        } catch (error: any) {
            console.error(`[QuestionnaireMigration] reading date defaults: ${error.message}`);
            return;
        }
        for (const row of rows) {
            try {
                await AppDataSource.transaction(async (m) => {
                    await m.query(`ALTER TABLE [${row.TableName}] DROP CONSTRAINT [${row.ConstraintName}]`);
                    await m.query(
                        `ALTER TABLE [${row.TableName}] ADD CONSTRAINT [DF_${row.TableName}_${row.ColumnName}_India]
                         DEFAULT (DATEADD(MINUTE, 330, GETUTCDATE())) FOR [${row.ColumnName}]`
                    );
                });
            } catch (error: any) {
                console.error(`[QuestionnaireMigration] ${row.TableName}.${row.ColumnName} default: ${error.message}`);
            }
        }
        if (rows.length) console.log(`[QuestionnaireMigration] ${rows.length} date columns now default to India time`);
    }
}
