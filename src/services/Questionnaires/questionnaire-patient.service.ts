import { AppDataSource } from "../../config/database.js";
import { notifyPatients } from "./questionnaire-admin.service.js";
import {
    QuestionnaireError,
    answersFor,
    genderFitsSql,
    loadForm,
    memberOfHospitalSql,
    normalizeGender,
    type FormQuestion,
} from "./questionnaire-shared.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type PatientQuestionnaireState = "due" | "available" | "completed";

export interface PatientQuestionnaire {
    id: number;
    title: string;
    description: string | null;
    categoryName: string | null;
    hospitalId: number;
    hospitalName: string | null;
    questionCount: number;
    allowMultiple: boolean;
    repeatAfterDays: number | null;
    status: string;
    attempts: number;
    lastSubmittedAt: Date | null;
    lastSubmissionId: number | null;
    /** Sent by the hospital and not answered yet. */
    requested: boolean;
    dueAt: Date | null;
    /** When the open request was sent, and who sent it when a member of staff sent it to this patient alone. */
    requestedAt: Date | null;
    requestedBy: string | null;
    canSubmit: boolean;
    /** When the next attempt opens, for questionnaires that repeat. */
    nextDueAt: Date | null;
    state: PatientQuestionnaireState;
    history: Array<{ id: number; attemptNo: number; submittedAt: Date }>;
}

/** What a patient sent for one question. Shapes by type are listed in validateAnswer. */
export interface AnswerInput {
    questionId: number;
    value: unknown;
}

interface CleanAnswer {
    question: FormQuestion;
    optionIds: number[];
    optionLabels: string[];
    text: string | null;
    number: number | null;
    date: string | null;
}

/**
 * Checks one answer against its question. Empty answers come back as null.
 * - SHORT_TEXT, LONG_TEXT: text
 * - NUMBER: a number within the question's range; RATING: a whole number 1-5
 * - SINGLE_CHOICE, DROPDOWN: an option id; MULTI_CHOICE: a list of option ids
 * - YES_NO: "Yes" or "No" (or true/false); DATE: "YYYY-MM-DD"
 */
export function validateAnswer(question: FormQuestion, value: unknown): CleanAnswer | null {
    const base = { question, optionIds: [] as number[], optionLabels: [] as string[], text: null, number: null, date: null };
    const empty = value === undefined || value === null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length);
    if (empty) return null;
    const fail = (why: string): never => {
        throw new QuestionnaireError(`"${question.text}": ${why}`);
    };
    const optionById = (raw: unknown) => {
        const id = Number(raw);
        const option = question.options.find((o) => o.id === id);
        if (!option) fail("pick one of the listed options.");
        return option!;
    };

    switch (question.typeCode) {
        case "SHORT_TEXT":
        case "LONG_TEXT": {
            const t = String(value).trim();
            const max = question.typeCode === "SHORT_TEXT" ? 500 : 5000;
            if (t.length > max) fail(`keep it under ${max} characters.`);
            return { ...base, text: t };
        }
        case "NUMBER":
        case "RATING": {
            const n = Number(value);
            if (!Number.isFinite(n)) fail("enter a number.");
            const min = question.typeCode === "RATING" ? 1 : question.minValue;
            const max = question.typeCode === "RATING" ? 5 : question.maxValue;
            if (question.typeCode === "RATING" && !Number.isInteger(n)) fail("pick a rating from 1 to 5.");
            if (min != null && n < min) fail(`enter ${min} or more.`);
            if (max != null && n > max) fail(`enter ${max} or less.`);
            return { ...base, number: n };
        }
        case "SINGLE_CHOICE":
        case "DROPDOWN": {
            const option = optionById(Array.isArray(value) ? value[0] : value);
            return { ...base, optionIds: [option.id], optionLabels: [option.label] };
        }
        case "MULTI_CHOICE": {
            const picked = (Array.isArray(value) ? value : [value]).map(optionById);
            const unique = [...new Map(picked.map((o) => [o.id, o])).values()].sort((a, b) => a.order - b.order);
            return { ...base, optionIds: unique.map((o) => o.id), optionLabels: unique.map((o) => o.label) };
        }
        case "YES_NO": {
            const v = typeof value === "boolean" ? (value ? "yes" : "no") : String(value).trim().toLowerCase();
            if (v !== "yes" && v !== "no") fail("answer Yes or No.");
            return { ...base, text: v === "yes" ? "Yes" : "No" };
        }
        case "DATE": {
            const v = String(value).trim();
            const date = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
            if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== v) fail("enter a valid date.");
            return { ...base, date: v };
        }
        default:
            return fail("this question type isn't supported.");
    }
}

export class QuestionnairePatientService {
    /** Published questionnaires the patient can see, plus closed ones they answered. */
    async list(patientId: string, onlyId?: number): Promise<PatientQuestionnaire[]> {
        const rows = await AppDataSource.query(
            `SELECT f.Id, f.Title, f.Description, f.AllowMultiple, f.RepeatAfterDays, f.Status, f.HospitalId,
                    h.Name AS HospitalName, c.Name AS CategoryName,
                    (SELECT COUNT(*) FROM QuestionnaireItems i WHERE i.QuestionnaireId = f.Id AND i.IsDeleted = 0) AS QuestionCount,
                    pa.Id AS PendingId, pa.DueAt, pa.SentAt AS PendingSentAt, pa.SentByName
             FROM Questionnaires f
             JOIN Users u ON u.Id = @0
             LEFT JOIN Hospitals h ON h.Id = f.HospitalId
             LEFT JOIN QuestionnaireCategories c ON c.Id = f.CategoryId
             OUTER APPLY (SELECT TOP 1 a.Id, a.DueAt, a.SentAt,
                                 CASE WHEN a.Source = 'Individual'
                                      THEN NULLIF(LTRIM(RTRIM(ISNULL(LTRIM(RTRIM(su.FirstName)), '') + ' ' + ISNULL(LTRIM(RTRIM(su.LastName)), ''))), '') END AS SentByName
                          FROM QuestionnaireAssignments a LEFT JOIN Users su ON su.Id = a.SentBy
                          WHERE a.QuestionnaireId = f.Id AND a.PatientUserId = @0 AND a.Status = 'Pending' AND a.IsDeleted = 0
                          ORDER BY a.SentAt) pa
             WHERE f.IsDeleted = 0 ${onlyId ? "AND f.Id = @1" : ""}
               AND (
                    (f.Status = 'Published' AND (pa.Id IS NOT NULL OR (${memberOfHospitalSql("@0", "f.HospitalId")} AND ${genderFitsSql("u.Gender", "f.TargetGender")})))
                 OR EXISTS (SELECT 1 FROM QuestionnaireSubmissions s WHERE s.QuestionnaireId = f.Id AND s.PatientUserId = @0 AND s.IsDeleted = 0)
               )`,
            onlyId ? [patientId, onlyId] : [patientId]
        );
        if (!rows.length) return [];

        const ids = rows.map((r: any) => r.Id);
        const submissions = await AppDataSource.query(
            `SELECT Id, QuestionnaireId, AttemptNo, SubmittedAt FROM QuestionnaireSubmissions
             WHERE PatientUserId = @0 AND IsDeleted = 0 AND QuestionnaireId IN (${ids.map((_: number, n: number) => `@${n + 1}`).join(",")})
             ORDER BY SubmittedAt DESC`,
            [patientId, ...ids]
        );

        const now = Date.now();
        const list = rows.map((r: any): PatientQuestionnaire => {
            const history = submissions
                .filter((s: any) => s.QuestionnaireId === r.Id)
                .map((s: any) => ({ id: s.Id, attemptNo: s.AttemptNo, submittedAt: s.SubmittedAt }));
            const last = history[0];
            const requested = r.PendingId != null;
            const published = r.Status === "Published";
            const allowMultiple = !!r.AllowMultiple;
            const repeat = r.RepeatAfterDays ?? null;
            let canSubmit = false;
            let state: PatientQuestionnaireState = "completed";
            let nextDueAt: Date | null = null;
            if (published) {
                if (requested || !last) {
                    canSubmit = true;
                    state = "due";
                } else if (allowMultiple && repeat) {
                    nextDueAt = new Date(new Date(last.submittedAt).getTime() + repeat * DAY_MS);
                    canSubmit = nextDueAt.getTime() <= now;
                    state = canSubmit ? "due" : "completed";
                } else if (allowMultiple) {
                    canSubmit = true;
                    state = "available";
                }
            }
            return {
                id: r.Id,
                title: r.Title,
                description: r.Description ?? null,
                categoryName: r.CategoryName ?? null,
                hospitalId: r.HospitalId,
                hospitalName: r.HospitalName ?? null,
                questionCount: r.QuestionCount,
                allowMultiple,
                repeatAfterDays: repeat,
                status: r.Status,
                attempts: history.length,
                lastSubmittedAt: last?.submittedAt ?? null,
                lastSubmissionId: last?.id ?? null,
                requested,
                dueAt: r.DueAt ?? null,
                requestedAt: r.PendingSentAt ?? null,
                requestedBy: r.SentByName ?? null,
                canSubmit,
                nextDueAt,
                state,
                history,
            };
        });
        const rank: Record<PatientQuestionnaireState, number> = { due: 0, available: 1, completed: 2 };
        return list.sort((a: PatientQuestionnaire, b: PatientQuestionnaire) =>
            rank[a.state] - rank[b.state] || a.title.localeCompare(b.title));
    }

    async pendingCount(patientId: string): Promise<number> {
        return (await this.list(patientId)).filter((q) => q.state === "due").length;
    }

    async getForm(patientId: string, questionnaireId: number) {
        const [entry] = await this.list(patientId, questionnaireId);
        if (!entry) throw new QuestionnaireError("This questionnaire isn't available to you.", 404);
        const form = await loadForm(questionnaireId);
        return { ...entry, questions: form.questions };
    }

    async submit(patientId: string, submittedBy: string, questionnaireId: number, rawAnswers: unknown) {
        const [entry] = await this.list(patientId, questionnaireId);
        if (!entry) throw new QuestionnaireError("This questionnaire isn't available to you.", 404);
        if (!entry.canSubmit) {
            throw new QuestionnaireError(
                entry.nextDueAt
                    ? `You can fill this in again from ${entry.nextDueAt.toISOString().slice(0, 10)}.`
                    : "You've already filled in this questionnaire.",
                409
            );
        }
        const form = await loadForm(questionnaireId);

        const given = new Map<number, unknown>();
        const list: AnswerInput[] = Array.isArray(rawAnswers)
            ? rawAnswers
            : rawAnswers && typeof rawAnswers === "object"
                ? Object.entries(rawAnswers as Record<string, unknown>).map(([k, v]) => ({ questionId: Number(k), value: v }))
                : [];
        for (const a of list) {
            const id = Number(a?.questionId);
            if (!form.questions.some((q) => q.id === id)) {
                throw new QuestionnaireError("An answer is for a question that isn't on this questionnaire.");
            }
            given.set(id, a?.value);
        }

        const clean: CleanAnswer[] = [];
        const missing: string[] = [];
        for (const question of form.questions) {
            const answer = validateAnswer(question, given.get(question.id));
            if (answer) clean.push(answer);
            else if (question.isRequired) missing.push(question.text);
        }
        if (missing.length) {
            throw new QuestionnaireError(
                missing.length === 1 ? `Please answer "${missing[0]}".` : `Please answer the ${missing.length} required questions.`,
                422
            );
        }
        if (!clean.length) throw new QuestionnaireError("Answer at least one question.");

        const [user] = await AppDataSource.query(`SELECT Gender FROM Users WHERE Id = @0`, [patientId]);
        const submissionId = await AppDataSource.transaction(async (m) => {
            const [count] = await m.query(
                `SELECT COUNT(*) AS N FROM QuestionnaireSubmissions WITH (UPDLOCK, HOLDLOCK)
                 WHERE QuestionnaireId = @0 AND PatientUserId = @1 AND IsDeleted = 0`,
                [questionnaireId, patientId]
            );
            const [pending] = await m.query(
                `SELECT TOP 1 Id FROM QuestionnaireAssignments
                 WHERE QuestionnaireId = @0 AND PatientUserId = @1 AND Status = 'Pending' AND IsDeleted = 0 ORDER BY SentAt`,
                [questionnaireId, patientId]
            );
            const [row] = await m.query(
                `INSERT INTO QuestionnaireSubmissions
                    (QuestionnaireId, HospitalId, OrganizationId, PatientUserId, AssignmentId, AttemptNo, PatientGender, SubmittedBy, CreatedBy)
                 OUTPUT INSERTED.Id VALUES (@0, @1, @2, @3, @4, @5, @6, @7, @7)`,
                [questionnaireId, form.hospitalId, form.organizationId, patientId, pending?.Id ?? null, count.N + 1,
                    normalizeGender(user?.Gender), submittedBy || patientId]
            );
            for (const a of clean) {
                await m.query(
                    `INSERT INTO QuestionnaireAnswers
                        (SubmissionId, QuestionId, QuestionText, TypeCode, OptionIds, OptionLabels, TextValue, NumberValue, DateValue)
                     VALUES (@0, @1, @2, @3, @4, @5, @6, @7, @8)`,
                    [row.Id, a.question.id, a.question.text, a.question.typeCode,
                        a.optionIds.length ? a.optionIds.join(",") : null,
                        a.optionLabels.length ? JSON.stringify(a.optionLabels) : null,
                        a.text, a.number, a.date]
                );
            }
            await m.query(
                `UPDATE QuestionnaireAssignments SET Status = 'Submitted', SubmissionId = @2, UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE())
                 WHERE QuestionnaireId = @0 AND PatientUserId = @1 AND Status = 'Pending' AND IsDeleted = 0`,
                [questionnaireId, patientId, row.Id]
            );
            return row.Id as number;
        });
        return this.getSubmission(patientId, submissionId);
    }

    async getSubmission(patientId: string, submissionId: number) {
        const [row] = await AppDataSource.query(
            `SELECT s.*, f.Title, h.Name AS HospitalName FROM QuestionnaireSubmissions s
             JOIN Questionnaires f ON f.Id = s.QuestionnaireId
             LEFT JOIN Hospitals h ON h.Id = s.HospitalId
             WHERE s.Id = @0 AND s.PatientUserId = @1 AND s.IsDeleted = 0`,
            [submissionId, patientId]
        );
        if (!row) throw new QuestionnaireError("Submission not found.", 404);
        return {
            id: row.Id,
            questionnaireId: row.QuestionnaireId,
            questionnaireTitle: row.Title,
            hospitalName: row.HospitalName ?? null,
            attemptNo: row.AttemptNo,
            submittedAt: row.SubmittedAt,
            answers: (await answersFor([row.Id])).get(row.Id) ?? [],
        };
    }

    /** A patient's submissions for their doctor, newest first, grouped by questionnaire. */
    async forDoctor(patientId: string, hospitalId?: number) {
        const rows = await AppDataSource.query(
            `SELECT s.Id, s.QuestionnaireId, s.AttemptNo, s.SubmittedAt, s.HospitalId,
                    f.Title, f.RepeatAfterDays, c.Name AS CategoryName, h.Name AS HospitalName
             FROM QuestionnaireSubmissions s
             JOIN Questionnaires f ON f.Id = s.QuestionnaireId
             LEFT JOIN QuestionnaireCategories c ON c.Id = f.CategoryId
             LEFT JOIN Hospitals h ON h.Id = s.HospitalId
             WHERE s.PatientUserId = @0 AND s.IsDeleted = 0 ${hospitalId ? "AND s.HospitalId = @1" : ""}
             ORDER BY s.SubmittedAt DESC`,
            hospitalId ? [patientId, hospitalId] : [patientId]
        );
        const answers = await answersFor(rows.map((r: any) => r.Id));
        const groups = new Map<number, any>();
        for (const r of rows) {
            const group = groups.get(r.QuestionnaireId) ?? {
                questionnaireId: r.QuestionnaireId,
                title: r.Title,
                categoryName: r.CategoryName ?? null,
                hospitalId: r.HospitalId,
                hospitalName: r.HospitalName ?? null,
                repeatAfterDays: r.RepeatAfterDays ?? null,
                lastSubmittedAt: r.SubmittedAt,
                attempts: [] as any[],
            };
            group.attempts.push({ id: r.Id, attemptNo: r.AttemptNo, submittedAt: r.SubmittedAt, answers: answers.get(r.Id) ?? [] });
            groups.set(r.QuestionnaireId, group);
        }
        return [...groups.values()];
    }

    /**
     * Repeating questionnaires: once a patient's last answer is RepeatAfterDays
     * old, they get a new request and a reminder. Each due date is asked once.
     */
    async createRepeatRequests(): Promise<number> {
        const created: Array<{ PatientUserId: string; QuestionnaireId: number }> = await AppDataSource.query(
            `INSERT INTO QuestionnaireAssignments (QuestionnaireId, HospitalId, OrganizationId, PatientUserId, Source)
             OUTPUT INSERTED.PatientUserId, INSERTED.QuestionnaireId
             SELECT f.Id, f.HospitalId, f.OrganizationId, last.PatientUserId, 'Repeat'
             FROM Questionnaires f
             CROSS APPLY (SELECT s.PatientUserId, MAX(s.SubmittedAt) AS LastAt
                          FROM QuestionnaireSubmissions s
                          WHERE s.QuestionnaireId = f.Id AND s.IsDeleted = 0
                          GROUP BY s.PatientUserId) last
             WHERE f.Status = 'Published' AND f.IsDeleted = 0 AND f.AllowMultiple = 1 AND f.RepeatAfterDays IS NOT NULL
               AND DATEADD(DAY, f.RepeatAfterDays, last.LastAt) <= DATEADD(MINUTE, 330, GETUTCDATE())
               AND NOT EXISTS (SELECT 1 FROM QuestionnaireAssignments a
                               WHERE a.QuestionnaireId = f.Id AND a.PatientUserId = last.PatientUserId AND a.IsDeleted = 0
                                 AND (a.Status = 'Pending' OR a.SentAt >= last.LastAt))`
        );
        if (!created.length) return 0;
        const byQuestionnaire = new Map<number, string[]>();
        for (const row of created) {
            const list = byQuestionnaire.get(row.QuestionnaireId) ?? [];
            list.push(String(row.PatientUserId));
            byQuestionnaire.set(row.QuestionnaireId, list);
        }
        for (const [id, patients] of byQuestionnaire) {
            const [q] = await AppDataSource.query(`SELECT Title, RepeatAfterDays FROM Questionnaires WHERE Id = @0`, [id]);
            await notifyPatients(patients, q?.Title ?? "Questionnaire", id,
                `It's time to fill in "${q?.Title ?? "your questionnaire"}" again.`);
        }
        return created.length;
    }

    private timer: NodeJS.Timeout | null = null;
    private running = false;

    /** Checks for due repeats every [minutes], sending only between 9am and 8pm. */
    startRepeatScheduler(minutes = 60) {
        if (this.timer) return;
        const tick = async () => {
            const hour = new Date().getHours();
            if (this.running || hour < 9 || hour >= 20) return;
            this.running = true;
            try {
                const n = await this.createRepeatRequests();
                if (n) console.log(`[Questionnaire] ${n} repeat request(s) sent.`);
            } catch (error: any) {
                console.error(`[Questionnaire] repeat scheduler: ${error?.message || error}`);
            } finally {
                this.running = false;
            }
        };
        this.timer = setInterval(tick, minutes * 60 * 1000);
        setTimeout(tick, 60 * 1000);
    }
}

export const questionnairePatientService = new QuestionnairePatientService();
