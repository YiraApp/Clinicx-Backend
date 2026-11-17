import { AppDataSource } from "../../config/database.js";

/** A problem with what was sent, shown to the user as is. */
export class QuestionnaireError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
    }
}

export const GENDERS = ["All", "Male", "Female", "Other"] as const;
export type TargetGender = (typeof GENDERS)[number];

/** SQL for a Users.Gender column as Male, Female, Other or NULL when unknown. */
export const genderSql = (column: string) => `(CASE
    WHEN LOWER(LTRIM(RTRIM(ISNULL(${column}, '')))) IN ('male', 'm') THEN 'Male'
    WHEN LOWER(LTRIM(RTRIM(ISNULL(${column}, '')))) IN ('female', 'f') THEN 'Female'
    WHEN LTRIM(RTRIM(ISNULL(${column}, ''))) = '' THEN NULL
    ELSE 'Other' END)`;

export function normalizeGender(value: unknown): "Male" | "Female" | "Other" | null {
    const v = String(value ?? "").trim().toLowerCase();
    if (!v) return null;
    if (v === "male" || v === "m") return "Male";
    if (v === "female" || v === "f") return "Female";
    return "Other";
}

export function targetGenderOf(value: unknown): TargetGender {
    const v = String(value ?? "All").trim().toLowerCase();
    const match = GENDERS.find((g) => g.toLowerCase() === v);
    if (!match) throw new QuestionnaireError("Target gender must be All, Male, Female or Other.");
    return match;
}

/**
 * SQL that is true when the user in [userColumn] belongs to the hospital in
 * [hospitalExpr]: registered with it, or has an appointment there that wasn't
 * cancelled. Same rule as checkHospitalRecordAccess.
 */
export const memberOfHospitalSql = (userColumn: string, hospitalExpr: string) => `(
    EXISTS (SELECT 1 FROM PatientRegistrations pr
            WHERE pr.UserId = ${userColumn} AND pr.HospitalId = ${hospitalExpr} AND pr.IsDeleted = 0)
    OR EXISTS (SELECT 1 FROM Appointments ap
               WHERE ap.UserId = ${userColumn} AND ap.HospitalId = ${hospitalExpr}
                 AND LOWER(ISNULL(ap.Status, '')) NOT IN ('cancelled', 'canceled', 'rejected')))`;

/** SQL that is true when the user's gender fits the questionnaire's target. */
export const genderFitsSql = (userGenderColumn: string, targetColumn: string) =>
    `(${targetColumn} = 'All' OR ${genderSql(userGenderColumn)} = ${targetColumn})`;

export async function organizationOf(hospitalId: number): Promise<number | null> {
    const rows = await AppDataSource.query(`SELECT OrganizationId FROM Hospitals WHERE Id = @0`, [hospitalId]);
    if (!rows.length) throw new QuestionnaireError("Hospital not found.", 404);
    return rows[0].OrganizationId ?? null;
}

export const text = (value: unknown, max: number, field: string, required = false): string | null => {
    const v = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
    if (!v) {
        if (required) throw new QuestionnaireError(`${field} is required.`);
        return null;
    }
    if (v.length > max) throw new QuestionnaireError(`${field} must be ${max} characters or fewer.`);
    return v;
};

export const optionalNumber = (value: unknown, field: string): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new QuestionnaireError(`${field} must be a number.`);
    return n;
};

export const positiveId = (value: unknown, field = "Id"): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new QuestionnaireError(`${field} is invalid.`);
    return n;
};

export interface FormOption { id: number; label: string; order: number }
export interface FormQuestion {
    id: number;
    order: number;
    text: string;
    helpText: string | null;
    typeCode: string;
    typeName: string;
    isRequired: boolean;
    minValue: number | null;
    maxValue: number | null;
    categoryName: string | null;
    options: FormOption[];
}
export interface FormQuestionnaire {
    id: number;
    hospitalId: number;
    organizationId: number | null;
    hospitalName: string | null;
    categoryId: number | null;
    categoryName: string | null;
    title: string;
    description: string | null;
    targetGender: TargetGender;
    allowMultiple: boolean;
    repeatAfterDays: number | null;
    status: string;
    publishedAt: Date | null;
    questions: FormQuestion[];
}

/** A questionnaire with its questions in order and each question's active options. */
export async function loadForm(questionnaireId: number, hospitalId?: number): Promise<FormQuestionnaire> {
    const [q] = await AppDataSource.query(
        `SELECT q.*, c.Name AS CategoryName, h.Name AS HospitalName
         FROM Questionnaires q
         LEFT JOIN QuestionnaireCategories c ON c.Id = q.CategoryId
         LEFT JOIN Hospitals h ON h.Id = q.HospitalId
         WHERE q.Id = @0 AND q.IsDeleted = 0 ${hospitalId ? "AND q.HospitalId = @1" : ""}`,
        hospitalId ? [questionnaireId, hospitalId] : [questionnaireId]
    );
    if (!q) throw new QuestionnaireError("Questionnaire not found.", 404);

    const items = await AppDataSource.query(
        `SELECT i.OrderNo, i.IsRequired, qq.Id, qq.Text, qq.HelpText, qq.MinValue, qq.MaxValue,
                t.Code AS TypeCode, t.Name AS TypeName, c.Name AS CategoryName
         FROM QuestionnaireItems i
         JOIN QuestionnaireQuestions qq ON qq.Id = i.QuestionId
         JOIN QuestionTypes t ON t.Id = qq.QuestionTypeId
         LEFT JOIN QuestionnaireCategories c ON c.Id = qq.CategoryId
         WHERE i.QuestionnaireId = @0 AND i.IsDeleted = 0
         ORDER BY i.OrderNo, i.Id`,
        [questionnaireId]
    );
    const ids = items.map((i: any) => Number(i.Id));
    const options = ids.length
        ? await AppDataSource.query(
            `SELECT Id, QuestionId, Label, OrderNo FROM QuestionnaireQuestionOptions
             WHERE QuestionId IN (${ids.map((_: number, n: number) => `@${n}`).join(",")})
               AND IsDeleted = 0 AND IsActive = 1
             ORDER BY OrderNo, Id`,
            ids
        )
        : [];

    return {
        id: q.Id,
        hospitalId: q.HospitalId,
        organizationId: q.OrganizationId ?? null,
        hospitalName: q.HospitalName ?? null,
        categoryId: q.CategoryId ?? null,
        categoryName: q.CategoryName ?? null,
        title: q.Title,
        description: q.Description ?? null,
        targetGender: q.TargetGender,
        allowMultiple: !!q.AllowMultiple,
        repeatAfterDays: q.RepeatAfterDays ?? null,
        status: q.Status,
        publishedAt: q.PublishedAt ?? null,
        questions: items.map((i: any) => ({
            id: i.Id,
            order: i.OrderNo,
            text: i.Text,
            helpText: i.HelpText ?? null,
            typeCode: i.TypeCode,
            typeName: i.TypeName,
            isRequired: !!i.IsRequired,
            minValue: i.MinValue ?? null,
            maxValue: i.MaxValue ?? null,
            categoryName: i.CategoryName ?? null,
            options: options
                .filter((o: any) => Number(o.QuestionId) === Number(i.Id))
                .map((o: any) => ({ id: o.Id, label: o.Label, order: o.OrderNo })),
        })),
    };
}

export interface SubmissionAnswer {
    questionId: number;
    questionText: string;
    typeCode: string;
    optionIds: number[];
    optionLabels: string[];
    text: string | null;
    number: number | null;
    date: string | null;
    /** The answer as one readable line. */
    display: string;
}

export function mapAnswer(row: any): SubmissionAnswer {
    let labels: string[] = [];
    try {
        labels = row.OptionLabels ? JSON.parse(row.OptionLabels) : [];
    } catch {
        labels = [];
    }
    const optionIds = String(row.OptionIds || "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const date = row.DateValue ? new Date(row.DateValue).toISOString().slice(0, 10) : null;
    const number = row.NumberValue ?? null;
    const display = labels.length ? labels.join(", ") : row.TextValue ?? (number != null ? String(number) : date ?? "");
    return {
        questionId: row.QuestionId,
        questionText: row.QuestionText,
        typeCode: row.TypeCode,
        optionIds,
        optionLabels: labels,
        text: row.TextValue ?? null,
        number,
        date,
        display,
    };
}

/** Answers for the given submissions, keyed by submission id. */
export async function answersFor(submissionIds: number[]): Promise<Map<number, SubmissionAnswer[]>> {
    const byId = new Map<number, SubmissionAnswer[]>();
    if (!submissionIds.length) return byId;
    for (let start = 0; start < submissionIds.length; start += 500) {
        const chunk = submissionIds.slice(start, start + 500);
        const rows = await AppDataSource.query(
            `SELECT * FROM QuestionnaireAnswers WHERE SubmissionId IN (${chunk.map((_, n) => `@${n}`).join(",")}) ORDER BY Id`,
            chunk
        );
        for (const row of rows) {
            const list = byId.get(Number(row.SubmissionId)) ?? [];
            list.push(mapAnswer(row));
            byId.set(Number(row.SubmissionId), list);
        }
    }
    return byId;
}
