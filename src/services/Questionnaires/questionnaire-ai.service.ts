import { AppDataSource } from "../../config/database.js";
import { questionnaireAnalyticsService, type AnalyticsFilter } from "./questionnaire-analytics.service.js";
import { QuestionnaireError, answersFor, loadForm } from "./questionnaire-shared.js";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_SUBMISSIONS = 300;

const PROMPT = `You are a healthcare quality analyst for a hospital. You get one patient questionnaire, its
questions, summary numbers, and de-identified submissions (each has a ref such as "S123", the attempt number,
gender, age band and days since it was submitted; no names or contact details).

Return JSON with exactly these keys:
{
  "summary": "3-5 plain sentences for hospital management on what the answers show",
  "keyFindings": [{"title": "...", "detail": "one or two sentences with numbers", "severity": "info|watch|concern"}],
  "kpis": [{"name": "...", "value": "number or short text", "unit": "% or count or blank", "description": "what it measures and why it matters"}],
  "alerts": [{"ref": "S123", "reason": "which answers are worrying and why", "severity": "medium|high"}],
  "trends": ["changes between first and later attempts, or over time, if the data shows any"],
  "recommendations": ["practical next steps for the hospital"]
}

Rules:
- Use only the data given. Do not invent numbers. If there is too little data, say so in the summary.
- kpis: 4 to 8 measures that suit THIS questionnaire's content (for example share of patients reporting a symptom,
  average rating, improvement between attempts), computed from the data.
- alerts: only submissions whose answers suggest the patient may need follow-up from the care team. Up to 20, most urgent first. Use refs exactly as given.
- No diagnoses and no medicine advice. Plain English, short sentences.
- Return ONLY valid JSON, no markdown.`;

const ageBand = (dob: any): string | null => {
    if (!dob) return null;
    const born = new Date(dob);
    if (Number.isNaN(born.getTime())) return null;
    const age = Math.floor((Date.now() - born.getTime()) / (365.25 * 24 * 3600 * 1000));
    if (age < 0 || age > 120) return null;
    if (age < 18) return "under 18";
    if (age >= 70) return "70+";
    const lo = Math.floor(age / 10) * 10;
    return `${lo}-${lo + 9}`;
};

const asList = (v: unknown) => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 600) => String(v ?? "").trim().slice(0, max);

class QuestionnaireAiService {
    private get apiKey() {
        return (process.env.GEMINI_API_KEY || "").trim();
    }

    private get model() {
        return (process.env.GEMINI_MODEL || "gemini-3.8-flash").trim();
    }

    get isConfigured() {
        return this.apiKey.length > 0;
    }

    async latest(hospitalId: number, questionnaireId?: number) {
        const [row] = await AppDataSource.query(
            `SELECT TOP 1 * FROM QuestionnaireInsights
             WHERE HospitalId = @0 AND ${questionnaireId ? "QuestionnaireId = @1" : "QuestionnaireId IS NULL"}
             ORDER BY CreatedAt DESC`,
            questionnaireId ? [hospitalId, questionnaireId] : [hospitalId]
        );
        if (!row) return null;
        try {
            return { ...JSON.parse(row.ResultJson), id: row.Id, generatedAt: row.CreatedAt, from: row.FromDate, to: row.ToDate };
        } catch {
            return null;
        }
    }

    /** Analyses one questionnaire's answers with Gemini and stores the result. */
    async generate(hospitalId: number, userId: string, filter: AnalyticsFilter) {
        if (!filter.questionnaireId) throw new QuestionnaireError("Pick a questionnaire to analyse.");
        if (!this.isConfigured) throw new QuestionnaireError("AI insights aren't set up on this server (GEMINI_API_KEY is missing).", 503);

        const form = await loadForm(filter.questionnaireId, hospitalId);
        const kpis = await questionnaireAnalyticsService.kpis(hospitalId, filter);
        const breakdown = await questionnaireAnalyticsService.breakdown(hospitalId, { ...filter, attempt: filter.attempt ?? "all" });
        if (!breakdown.submissions) throw new QuestionnaireError("There are no submissions to analyse yet.");

        const params: any[] = [hospitalId, filter.questionnaireId];
        const where = ["s.HospitalId = @0", "s.QuestionnaireId = @1", "s.IsDeleted = 0"];
        if (filter.from) { params.push(filter.from); where.push(`s.SubmittedAt >= @${params.length - 1}`); }
        if (filter.to) { params.push(filter.to); where.push(`s.SubmittedAt < DATEADD(DAY, 1, CAST(@${params.length - 1} AS DATE))`); }
        if (filter.gender) { params.push(filter.gender); where.push(`s.PatientGender = @${params.length - 1}`); }
        const subs = await AppDataSource.query(
            `SELECT TOP ${MAX_SUBMISSIONS} s.Id, s.PatientUserId, s.AttemptNo, s.SubmittedAt, s.PatientGender, u.DateOfBirth
             FROM QuestionnaireSubmissions s LEFT JOIN Users u ON u.Id = s.PatientUserId
             WHERE ${where.join(" AND ")} ORDER BY s.SubmittedAt DESC`,
            params
        );
        const answers = await answersFor(subs.map((r: any) => r.Id));
        const questionIndex = new Map(form.questions.map((q, n) => [q.id, `Q${n + 1}`]));

        const data = {
            questionnaire: { title: form.title, description: form.description, targetGender: form.targetGender, repeatAfterDays: form.repeatAfterDays },
            questions: form.questions.map((q, n) => ({ id: `Q${n + 1}`, text: q.text, type: q.typeName, options: q.options.map((o) => o.label) })),
            summary: {
                submissions: breakdown.submissions,
                respondents: kpis.respondents,
                completionRate: kpis.completionRate,
                repeatSubmissions: kpis.repeatSubmissions,
                avgDaysBetweenAttempts: kpis.avgDaysBetweenAttempts,
                byGender: kpis.byGender,
                perQuestion: breakdown.questions.map((q: any) => ({
                    id: questionIndex.get(q.questionId),
                    answered: q.answered,
                    options: q.options,
                    average: q.average,
                    median: q.median,
                })),
            },
            submissions: subs.map((r: any) => ({
                ref: `S${r.Id}`,
                attempt: r.AttemptNo,
                gender: r.PatientGender ?? "Unknown",
                ageBand: ageBand(r.DateOfBirth),
                daysAgo: Math.max(0, Math.round((Date.now() - new Date(r.SubmittedAt).getTime()) / 86400000)),
                answers: Object.fromEntries((answers.get(r.Id) ?? []).map((a) => [questionIndex.get(a.questionId) ?? a.questionText, str(a.display, 300)])),
            })),
        };

        const result = this.normalize(await this.call(JSON.stringify(data)));

        // Refs back to patients, on the server only: the model never saw who they are.
        const byRef = new Map<string, any>(subs.map((r: any) => [`S${r.Id}`, r]));
        const patientIds = [...new Set(result.alerts.map((a) => byRef.get(a.ref)?.PatientUserId).filter(Boolean))] as string[];
        const names = new Map<string, string>();
        if (patientIds.length) {
            const rows = await AppDataSource.query(
                `SELECT Id, FirstName, LastName FROM Users WHERE Id IN (${patientIds.map((_, n) => `@${n}`).join(",")})`,
                patientIds
            );
            for (const u of rows) names.set(String(u.Id).toLowerCase(), `${u.FirstName ?? ""} ${u.LastName ?? ""}`.trim() || "Patient");
        }
        const alerts = result.alerts
            .filter((a) => byRef.has(a.ref))
            .map((a) => {
                const sub: any = byRef.get(a.ref);
                return {
                    ...a,
                    submissionId: sub.Id,
                    attemptNo: sub.AttemptNo,
                    submittedAt: sub.SubmittedAt,
                    patientId: sub.PatientUserId,
                    patientName: names.get(String(sub.PatientUserId).toLowerCase()) ?? "Patient",
                };
            });

        const stored = {
            ...result,
            alerts,
            questionnaireId: form.id,
            questionnaireTitle: form.title,
            analysedSubmissions: subs.length,
            totalSubmissions: breakdown.submissions,
        };
        const [row] = await AppDataSource.query(
            `INSERT INTO QuestionnaireInsights (HospitalId, QuestionnaireId, FromDate, ToDate, ResultJson, CreatedBy)
             OUTPUT INSERTED.Id, INSERTED.CreatedAt VALUES (@0, @1, @2, @3, @4, @5)`,
            [hospitalId, form.id, filter.from || null, filter.to || null, JSON.stringify(stored), userId || null]
        );
        return { ...stored, id: row.Id, generatedAt: row.CreatedAt, from: filter.from ?? null, to: filter.to ?? null };
    }

    private async call(data: string): Promise<any> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90_000);
        let response: Response;
        try {
            response = await fetch(`${GEMINI_URL}/${this.model}:generateContent`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
                signal: controller.signal,
                body: JSON.stringify({
                    contents: [{ parts: [{ text: PROMPT }, { text: `DATA:\n${data}` }] }],
                    generationConfig: { temperature: 0.2, maxOutputTokens: 8192, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
                }),
            });
        } catch (err: any) {
            throw new QuestionnaireError(err?.name === "AbortError" ? "The analysis took too long. Please try again." : "Could not reach the AI service.", 502);
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            console.error(`[QuestionnaireAI] Gemini ${response.status}: ${body.slice(0, 300)}`);
            throw new QuestionnaireError(response.status === 429 ? "The AI service is busy. Try again in a minute." : "The AI service returned an error.", 502);
        }
        const json: any = await response.json();
        const out = (json?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("").trim();
        try {
            return JSON.parse(out.replace(/^```\w*\s*/, "").replace(/\s*```$/, ""));
        } catch {
            console.error("[QuestionnaireAI] Unparseable reply:", out.slice(0, 300));
            throw new QuestionnaireError("The AI reply couldn't be read. Please try again.", 502);
        }
    }

    private normalize(raw: any) {
        const severity = (v: unknown, allowed: string[], fallback: string) => (allowed.includes(String(v)) ? String(v) : fallback);
        return {
            summary: str(raw?.summary, 2000),
            keyFindings: asList(raw?.keyFindings).slice(0, 10).map((f: any) => ({
                title: str(f?.title, 150), detail: str(f?.detail), severity: severity(f?.severity, ["info", "watch", "concern"], "info"),
            })),
            kpis: asList(raw?.kpis).slice(0, 8).map((k: any) => ({
                name: str(k?.name, 120), value: str(k?.value, 40), unit: str(k?.unit, 20), description: str(k?.description, 300),
            })),
            alerts: asList(raw?.alerts).slice(0, 20).map((a: any) => ({
                ref: str(a?.ref, 20), reason: str(a?.reason, 400), severity: severity(a?.severity, ["medium", "high"], "medium"),
            })),
            trends: asList(raw?.trends).slice(0, 6).map((t: any) => str(t, 400)),
            recommendations: asList(raw?.recommendations).slice(0, 8).map((t: any) => str(t, 400)),
        };
    }
}

export const questionnaireAiService = new QuestionnaireAiService();
