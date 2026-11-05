import { AppDataSource } from "../../config/database.js";
import { QuestionnaireError, answersFor, genderFitsSql, loadForm, memberOfHospitalSql } from "./questionnaire-shared.js";

export interface AnalyticsFilter {
    questionnaireId?: number;
    categoryId?: number;
    from?: string;
    to?: string;
    gender?: string;
    /** Which attempts count: every one, each patient's first, or each patient's latest. */
    attempt?: "all" | "first" | "latest";
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** WHERE clauses for submissions (alias s) and the questionnaire (alias f). */
function submissionWhere(hospitalId: number, filter: AnalyticsFilter) {
    const params: any[] = [hospitalId];
    const where = ["s.HospitalId = @0", "s.IsDeleted = 0", "f.IsDeleted = 0"];
    const add = (sql: (p: string) => string, value: any) => {
        params.push(value);
        where.push(sql(`@${params.length - 1}`));
    };
    if (filter.questionnaireId) add((p) => `s.QuestionnaireId = ${p}`, filter.questionnaireId);
    if (filter.categoryId) add((p) => `f.CategoryId = ${p}`, filter.categoryId);
    if (filter.from && DATE.test(filter.from)) add((p) => `s.SubmittedAt >= ${p}`, filter.from);
    if (filter.to && DATE.test(filter.to)) add((p) => `s.SubmittedAt < DATEADD(DAY, 1, CAST(${p} AS DATE))`, filter.to);
    if (filter.gender && ["Male", "Female", "Other"].includes(filter.gender)) add((p) => `s.PatientGender = ${p}`, filter.gender);
    if (filter.attempt === "first") where.push("s.AttemptNo = 1");
    if (filter.attempt === "latest") {
        where.push(`s.AttemptNo = (SELECT MAX(s2.AttemptNo) FROM QuestionnaireSubmissions s2
                     WHERE s2.QuestionnaireId = s.QuestionnaireId AND s2.PatientUserId = s.PatientUserId AND s2.IsDeleted = 0)`);
    }
    return { params, where: where.join(" AND ") };
}

/** WHERE clauses for requests sent (alias a) with the same filters. */
function assignmentWhere(hospitalId: number, filter: AnalyticsFilter) {
    const params: any[] = [hospitalId];
    const where = ["a.HospitalId = @0", "a.IsDeleted = 0", "f.IsDeleted = 0"];
    const add = (sql: (p: string) => string, value: any) => {
        params.push(value);
        where.push(sql(`@${params.length - 1}`));
    };
    if (filter.questionnaireId) add((p) => `a.QuestionnaireId = ${p}`, filter.questionnaireId);
    if (filter.categoryId) add((p) => `f.CategoryId = ${p}`, filter.categoryId);
    if (filter.from && DATE.test(filter.from)) add((p) => `a.SentAt >= ${p}`, filter.from);
    if (filter.to && DATE.test(filter.to)) add((p) => `a.SentAt < DATEADD(DAY, 1, CAST(${p} AS DATE))`, filter.to);
    if (filter.gender && ["Male", "Female", "Other"].includes(filter.gender)) {
        add((p) => `${genderFitsSql("u.Gender", p)} AND ${p} <> 'All'`, filter.gender);
    }
    return { params, where: where.join(" AND ") };
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export class QuestionnaireAnalyticsService {
    async kpis(hospitalId: number, filter: AnalyticsFilter) {
        const s = submissionWhere(hospitalId, { ...filter, attempt: "all" });
        const a = assignmentWhere(hospitalId, filter);

        const [counts] = await AppDataSource.query(
            `SELECT
                (SELECT COUNT(*) FROM Questionnaires WHERE HospitalId = @0 AND IsDeleted = 0 AND Status = 'Published') AS Published,
                (SELECT COUNT(*) FROM Questionnaires WHERE HospitalId = @0 AND IsDeleted = 0 AND Status = 'Draft') AS Drafts,
                (SELECT COUNT(*) FROM Questionnaires WHERE HospitalId = @0 AND IsDeleted = 0 AND Status = 'Closed') AS Closed,
                (SELECT COUNT(*) FROM QuestionnaireQuestions WHERE HospitalId = @0 AND IsDeleted = 0) AS BankQuestions,
                (SELECT COUNT(*) FROM Users u WHERE u.IsDeleted = 0 AND ${memberOfHospitalSql("u.Id", "@0")}) AS HospitalPatients`,
            [hospitalId]
        );
        const [subs] = await AppDataSource.query(
            `SELECT COUNT(*) AS Submissions,
                    COUNT(DISTINCT s.PatientUserId) AS Respondents,
                    SUM(CASE WHEN s.AttemptNo > 1 THEN 1 ELSE 0 END) AS Repeats,
                    SUM(CASE WHEN s.SubmittedBy IS NOT NULL AND s.SubmittedBy <> s.PatientUserId THEN 1 ELSE 0 END) AS ByFamily
             FROM QuestionnaireSubmissions s JOIN Questionnaires f ON f.Id = s.QuestionnaireId
             WHERE ${s.where}`,
            s.params
        );
        const [gap] = await AppDataSource.query(
            `SELECT AVG(CAST(DATEDIFF(HOUR, prev.SubmittedAt, s.SubmittedAt) AS FLOAT)) / 24.0 AS AvgDays
             FROM QuestionnaireSubmissions s JOIN Questionnaires f ON f.Id = s.QuestionnaireId
             CROSS APPLY (SELECT TOP 1 p.SubmittedAt FROM QuestionnaireSubmissions p
                          WHERE p.QuestionnaireId = s.QuestionnaireId AND p.PatientUserId = s.PatientUserId
                            AND p.IsDeleted = 0 AND p.AttemptNo = s.AttemptNo - 1) prev
             WHERE ${s.where} AND s.AttemptNo > 1`,
            s.params
        );
        const [sent] = await AppDataSource.query(
            `SELECT COUNT(*) AS Sent,
                    SUM(CASE WHEN a.Status = 'Submitted' THEN 1 ELSE 0 END) AS Completed,
                    SUM(CASE WHEN a.Status = 'Pending' THEN 1 ELSE 0 END) AS Pending,
                    SUM(CASE WHEN a.Status = 'Pending' AND a.DueAt < DATEADD(MINUTE, 330, GETUTCDATE()) THEN 1 ELSE 0 END) AS Overdue,
                    SUM(CASE WHEN a.Status = 'Withdrawn' THEN 1 ELSE 0 END) AS Withdrawn,
                    SUM(CASE WHEN a.Source = 'Repeat' THEN 1 ELSE 0 END) AS RepeatRequests,
                    AVG(CASE WHEN a.Status = 'Submitted' THEN CAST(DATEDIFF(MINUTE, a.SentAt, sub.SubmittedAt) AS FLOAT) END) / 60.0 AS AvgHoursToRespond
             FROM QuestionnaireAssignments a
             JOIN Questionnaires f ON f.Id = a.QuestionnaireId
             LEFT JOIN Users u ON u.Id = a.PatientUserId
             LEFT JOIN QuestionnaireSubmissions sub ON sub.Id = a.SubmissionId
             WHERE ${a.where}`,
            a.params
        );
        const byGender = await AppDataSource.query(
            `SELECT ISNULL(s.PatientGender, 'Unknown') AS Gender, COUNT(*) AS Submissions, COUNT(DISTINCT s.PatientUserId) AS Respondents
             FROM QuestionnaireSubmissions s JOIN Questionnaires f ON f.Id = s.QuestionnaireId
             WHERE ${s.where} GROUP BY ISNULL(s.PatientGender, 'Unknown') ORDER BY COUNT(*) DESC`,
            s.params
        );
        const byQuestionnaire = await AppDataSource.query(
            `SELECT f.Id, f.Title, f.Status, f.TargetGender,
                    (SELECT COUNT(*) FROM QuestionnaireAssignments a WHERE a.QuestionnaireId = f.Id AND a.IsDeleted = 0 AND a.Status <> 'Withdrawn') AS Sent,
                    (SELECT COUNT(*) FROM QuestionnaireAssignments a WHERE a.QuestionnaireId = f.Id AND a.IsDeleted = 0 AND a.Status = 'Submitted') AS Completed,
                    (SELECT COUNT(*) FROM QuestionnaireSubmissions s WHERE s.QuestionnaireId = f.Id AND s.IsDeleted = 0) AS Submissions,
                    (SELECT COUNT(DISTINCT s.PatientUserId) FROM QuestionnaireSubmissions s WHERE s.QuestionnaireId = f.Id AND s.IsDeleted = 0) AS Respondents,
                    (SELECT MAX(s.SubmittedAt) FROM QuestionnaireSubmissions s WHERE s.QuestionnaireId = f.Id AND s.IsDeleted = 0) AS LastSubmittedAt
             FROM Questionnaires f
             WHERE f.HospitalId = @0 AND f.IsDeleted = 0 AND f.Status <> 'Draft'
               ${filter.questionnaireId ? "AND f.Id = @1" : ""}
             ORDER BY f.Status, f.Title`,
            filter.questionnaireId ? [hospitalId, filter.questionnaireId] : [hospitalId]
        );

        const sentActive = (sent.Sent ?? 0) - (sent.Withdrawn ?? 0);
        return {
            questionnaires: { published: counts.Published, drafts: counts.Drafts, closed: counts.Closed, bankQuestions: counts.BankQuestions },
            hospitalPatients: counts.HospitalPatients,
            sent: sentActive,
            completed: sent.Completed ?? 0,
            pending: sent.Pending ?? 0,
            overdue: sent.Overdue ?? 0,
            repeatRequests: sent.RepeatRequests ?? 0,
            completionRate: pct(sent.Completed ?? 0, sentActive),
            avgHoursToRespond: sent.AvgHoursToRespond != null ? Math.round(sent.AvgHoursToRespond * 10) / 10 : null,
            submissions: subs.Submissions ?? 0,
            respondents: subs.Respondents ?? 0,
            reachRate: pct(subs.Respondents ?? 0, counts.HospitalPatients),
            repeatSubmissions: subs.Repeats ?? 0,
            filledByFamily: subs.ByFamily ?? 0,
            avgDaysBetweenAttempts: gap?.AvgDays != null ? Math.round(gap.AvgDays * 10) / 10 : null,
            byGender: byGender.map((r: any) => ({ gender: r.Gender, submissions: r.Submissions, respondents: r.Respondents })),
            byQuestionnaire: byQuestionnaire.map((r: any) => ({
                id: r.Id,
                title: r.Title,
                status: r.Status,
                targetGender: r.TargetGender,
                sent: r.Sent,
                completed: r.Completed,
                completionRate: pct(r.Completed, r.Sent),
                submissions: r.Submissions,
                respondents: r.Respondents,
                lastSubmittedAt: r.LastSubmittedAt ?? null,
            })),
        };
    }

    /** How patients answered each question of one questionnaire. */
    async breakdown(hospitalId: number, filter: AnalyticsFilter) {
        if (!filter.questionnaireId) throw new QuestionnaireError("Pick a questionnaire.");
        const form = await loadForm(filter.questionnaireId, hospitalId);
        const s = submissionWhere(hospitalId, filter);
        const [total] = await AppDataSource.query(
            `SELECT COUNT(*) AS N FROM QuestionnaireSubmissions s JOIN Questionnaires f ON f.Id = s.QuestionnaireId WHERE ${s.where}`,
            s.params
        );
        const rows = await AppDataSource.query(
            `SELECT a.QuestionId, a.TypeCode, a.OptionLabels, a.TextValue, a.NumberValue, a.DateValue, s.SubmittedAt
             FROM QuestionnaireAnswers a
             JOIN QuestionnaireSubmissions s ON s.Id = a.SubmissionId
             JOIN Questionnaires f ON f.Id = s.QuestionnaireId
             WHERE ${s.where}
             ORDER BY s.SubmittedAt DESC`,
            s.params
        );
        const submissions = total.N as number;

        const questions = form.questions.map((q) => {
            const answers = rows.filter((r: any) => r.QuestionId === q.id);
            const base = {
                questionId: q.id,
                text: q.text,
                typeCode: q.typeCode,
                typeName: q.typeName,
                isRequired: q.isRequired,
                answered: answers.length,
                responseRate: pct(answers.length, submissions),
            };
            if (["SINGLE_CHOICE", "MULTI_CHOICE", "DROPDOWN", "YES_NO"].includes(q.typeCode)) {
                const counts = new Map<string, number>();
                const labels = q.typeCode === "YES_NO" ? ["Yes", "No"] : q.options.map((o) => o.label);
                for (const label of labels) counts.set(label, 0);
                for (const a of answers) {
                    let picked: string[] = [];
                    if (q.typeCode === "YES_NO") picked = a.TextValue ? [a.TextValue] : [];
                    else {
                        try { picked = JSON.parse(a.OptionLabels || "[]"); } catch { picked = []; }
                    }
                    for (const label of picked) counts.set(label, (counts.get(label) ?? 0) + 1);
                }
                const denominator = q.typeCode === "MULTI_CHOICE" ? answers.length : [...counts.values()].reduce((x, y) => x + y, 0);
                return {
                    ...base,
                    kind: "choice" as const,
                    options: [...counts.entries()].map(([label, count]) => ({ label, count, percent: pct(count, denominator) })),
                };
            }
            if (q.typeCode === "NUMBER" || q.typeCode === "RATING") {
                const values = answers.map((a: any) => Number(a.NumberValue)).filter((n: number) => Number.isFinite(n));
                const sorted = [...values].sort((x, y) => x - y);
                const avg = values.length ? values.reduce((x: number, y: number) => x + y, 0) / values.length : null;
                const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
                let buckets: Array<{ label: string; count: number }> = [];
                if (q.typeCode === "RATING") {
                    buckets = [1, 2, 3, 4, 5].map((n) => ({ label: String(n), count: values.filter((v: number) => v === n).length }));
                } else if (sorted.length) {
                    const min = sorted[0];
                    const max = sorted[sorted.length - 1];
                    const steps = min === max ? 1 : Math.min(8, Math.max(3, Math.ceil(Math.sqrt(sorted.length))));
                    const width = (max - min) / steps || 1;
                    buckets = Array.from({ length: steps }, (_, n) => {
                        const lo = min + n * width;
                        const hi = n === steps - 1 ? max : lo + width;
                        const round = (v: number) => Math.round(v * 10) / 10;
                        return {
                            label: min === max ? String(round(min)) : `${round(lo)}–${round(hi)}`,
                            count: sorted.filter((v) => (n === steps - 1 ? v >= lo && v <= hi : v >= lo && v < hi)).length,
                        };
                    });
                }
                const round = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
                return {
                    ...base,
                    kind: "number" as const,
                    average: round(avg),
                    median: round(median),
                    min: sorted.length ? sorted[0] : null,
                    max: sorted.length ? sorted[sorted.length - 1] : null,
                    buckets,
                };
            }
            if (q.typeCode === "DATE") {
                const dates = answers.map((a: any) => (a.DateValue ? new Date(a.DateValue).toISOString().slice(0, 10) : null)).filter(Boolean).sort();
                return { ...base, kind: "date" as const, earliest: dates[0] ?? null, latest: dates[dates.length - 1] ?? null };
            }
            return {
                ...base,
                kind: "text" as const,
                samples: answers.slice(0, 10).map((a: any) => ({ text: String(a.TextValue ?? ""), submittedAt: a.SubmittedAt })),
            };
        });

        return { questionnaireId: form.id, title: form.title, submissions, questions };
    }

    /** Requests sent, submissions and new respondents per week or month. */
    async trends(hospitalId: number, filter: AnalyticsFilter & { interval?: "week" | "month" }) {
        const interval = filter.interval === "month" ? "month" : "week";
        const bucket = (col: string) =>
            interval === "month" ? `DATEFROMPARTS(YEAR(${col}), MONTH(${col}), 1)` : `CAST(DATEADD(DAY, 1 - DATEPART(WEEKDAY, ${col}), CAST(${col} AS DATE)) AS DATE)`;
        const range = { ...filter };
        if (!range.from) {
            const d = new Date();
            d.setDate(d.getDate() - (interval === "month" ? 365 : 84));
            range.from = d.toISOString().slice(0, 10);
        }
        const s = submissionWhere(hospitalId, { ...range, attempt: "all" });
        const a = assignmentWhere(hospitalId, range);
        const subs = await AppDataSource.query(
            `SELECT ${bucket("s.SubmittedAt")} AS Period, COUNT(*) AS Submissions, COUNT(DISTINCT s.PatientUserId) AS Respondents,
                    SUM(CASE WHEN s.AttemptNo = 1 THEN 1 ELSE 0 END) AS FirstAttempts,
                    SUM(CASE WHEN s.AttemptNo > 1 THEN 1 ELSE 0 END) AS Repeats
             FROM QuestionnaireSubmissions s JOIN Questionnaires f ON f.Id = s.QuestionnaireId
             WHERE ${s.where} GROUP BY ${bucket("s.SubmittedAt")}`,
            s.params
        );
        const sent = await AppDataSource.query(
            `SELECT ${bucket("a.SentAt")} AS Period, COUNT(*) AS Sent
             FROM QuestionnaireAssignments a JOIN Questionnaires f ON f.Id = a.QuestionnaireId LEFT JOIN Users u ON u.Id = a.PatientUserId
             WHERE ${a.where} GROUP BY ${bucket("a.SentAt")}`,
            a.params
        );
        const key = (d: any) => new Date(d).toISOString().slice(0, 10);
        const periods = new Map<string, any>();
        const row = (k: string) => periods.get(k) ?? { period: k, sent: 0, submissions: 0, respondents: 0, firstAttempts: 0, repeats: 0 };
        for (const r of subs) {
            const p = row(key(r.Period));
            Object.assign(p, { submissions: r.Submissions, respondents: r.Respondents, firstAttempts: r.FirstAttempts, repeats: r.Repeats });
            periods.set(p.period, p);
        }
        for (const r of sent) {
            const p = row(key(r.Period));
            p.sent = r.Sent;
            periods.set(p.period, p);
        }
        return { interval, points: [...periods.values()].sort((x, y) => x.period.localeCompare(y.period)) };
    }

    /** CSV: one row per submission for a single questionnaire, else one row per answer. */
    async exportCsv(hospitalId: number, filter: AnalyticsFilter): Promise<{ fileName: string; csv: string }> {
        const s = submissionWhere(hospitalId, filter);
        const subs = await AppDataSource.query(
            `SELECT s.Id, s.QuestionnaireId, s.AttemptNo, s.SubmittedAt, s.PatientGender, f.Title,
                    u.FirstName, u.LastName, u.PhoneNumber
             FROM QuestionnaireSubmissions s
             JOIN Questionnaires f ON f.Id = s.QuestionnaireId
             LEFT JOIN Users u ON u.Id = s.PatientUserId
             WHERE ${s.where}
             ORDER BY s.SubmittedAt DESC`,
            s.params
        );
        if (subs.length > 20000) throw new QuestionnaireError("That's more than 20,000 submissions. Narrow the dates or pick one questionnaire.");
        const answers = await answersFor(subs.map((r: any) => r.Id));
        const cell = (v: unknown) => {
            const t = v == null ? "" : String(v);
            // Leading = + - @ would run as a formula in Excel.
            const safe = /^[=+\-@]/.test(t) ? `'${t}` : t;
            return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
        };
        const line = (cells: unknown[]) => cells.map(cell).join(",");
        const when = (d: any) => new Date(d).toISOString().replace("T", " ").slice(0, 16);
        const name = (r: any) => `${r.FirstName ?? ""} ${r.LastName ?? ""}`.trim();
        const stamp = new Date().toISOString().slice(0, 10);

        if (filter.questionnaireId) {
            const form = await loadForm(filter.questionnaireId, hospitalId);
            const header = ["Submission", "Submitted at", "Attempt", "Patient", "Phone", "Gender", ...form.questions.map((q) => q.text)];
            const lines = subs.map((r: any) => {
                const byQuestion = new Map((answers.get(r.Id) ?? []).map((a) => [a.questionId, a.display]));
                return line([r.Id, when(r.SubmittedAt), r.AttemptNo, name(r), r.PhoneNumber, r.PatientGender,
                    ...form.questions.map((q) => byQuestion.get(q.id) ?? "")]);
            });
            const slug = form.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "questionnaire";
            return { fileName: `${slug}-${stamp}.csv`, csv: "﻿" + [line(header), ...lines].join("\r\n") };
        }
        const header = ["Submission", "Questionnaire", "Submitted at", "Attempt", "Patient", "Phone", "Gender", "Question", "Answer"];
        const lines: string[] = [];
        for (const r of subs) {
            for (const a of answers.get(r.Id) ?? []) {
                lines.push(line([r.Id, r.Title, when(r.SubmittedAt), r.AttemptNo, name(r), r.PhoneNumber, r.PatientGender, a.questionText, a.display]));
            }
        }
        return { fileName: `questionnaire-answers-${stamp}.csv`, csv: "﻿" + [line(header), ...lines].join("\r\n") };
    }
}

export const questionnaireAnalyticsService = new QuestionnaireAnalyticsService();
