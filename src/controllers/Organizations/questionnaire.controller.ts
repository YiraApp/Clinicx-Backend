import type { Request, Response } from "express";
import { questionnaireAdminService as admin } from "../../services/Questionnaires/questionnaire-admin.service.js";
import { questionnaireAiService as ai } from "../../services/Questionnaires/questionnaire-ai.service.js";
import { questionnaireAnalyticsService as analytics, type AnalyticsFilter } from "../../services/Questionnaires/questionnaire-analytics.service.js";
import { QuestionnaireError } from "../../services/Questionnaires/questionnaire-shared.js";
import { canManageHospital, isHospitalStaff, isSystemAdmin } from "../../utils/hospital-admin-access.js";
import { ApiResponse } from "../../utils/response.utils.js";

const userIdOf = (req: Request) => String((req as any).user?.userId || (req as any).user?.id || "").trim();
const num = (v: unknown) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
};

function filterOf(req: Request): AnalyticsFilter {
    const q = req.query;
    const attempt = String(q.attempt || "all");
    return {
        questionnaireId: num(q.questionnaireId),
        categoryId: num(q.categoryId),
        from: typeof q.from === "string" ? q.from : undefined,
        to: typeof q.to === "string" ? q.to : undefined,
        gender: typeof q.gender === "string" && q.gender !== "All" ? q.gender : undefined,
        attempt: attempt === "first" || attempt === "latest" ? attempt : "all",
    };
}

type Handler = (ctx: { req: Request; res: Response; hospitalId: number; userId: string; id: number }) => Promise<unknown>;

/**
 * Every questionnaire admin route: the caller must manage this hospital
 * (its admins, its organization's admins, or system admins).
 */
function route(handler: Handler, message = "Done.", status = 200, who: "admins" | "staff" = "admins") {
    return async (req: Request, res: Response) => {
        try {
            const hospitalId = Number(req.params.hospitalId);
            const userId = userIdOf(req);
            if (!Number.isInteger(hospitalId) || hospitalId <= 0) {
                return res.status(400).json(ApiResponse.error("Hospital ID is required."));
            }
            const allowed = who === "staff" ? await isHospitalStaff(userId, hospitalId) : await canManageHospital(userId, hospitalId);
            if (!userId || !allowed) {
                return res.status(403).json(ApiResponse.error(
                    who === "staff" ? "Only this hospital's staff can send questionnaires to its patients." : "Only this hospital's admins can manage its questionnaires."
                ));
            }
            const result = await handler({ req, res, hospitalId, userId, id: Number(req.params.id) });
            if (res.headersSent) return;
            return res.status(status).json(ApiResponse.success(result ?? null, message));
        } catch (error: any) {
            if (error instanceof QuestionnaireError) {
                return res.status(error.status).json(ApiResponse.error(error.message));
            }
            console.error("[Questionnaire]", error?.message || error);
            return res.status(500).json(ApiResponse.error("Something went wrong. Please try again."));
        }
    };
}

export const questionnaireController = {
    // Question types
    listTypes: route(() => admin.listTypes()),
    updateType: route(async ({ req, userId, id }) => {
        if (!(await isSystemAdmin(userId))) throw new QuestionnaireError("Only system admins can change question types.", 403);
        return admin.updateType(id, req.body ?? {});
    }, "Question type updated."),

    // Categories
    listCategories: route(({ hospitalId }) => admin.listCategories(hospitalId)),
    createCategory: route(({ req, hospitalId, userId }) => admin.createCategory(hospitalId, userId, req.body ?? {}), "Category added.", 201),
    updateCategory: route(({ req, hospitalId, id }) => admin.updateCategory(hospitalId, id, req.body ?? {}), "Category updated."),
    removeCategory: route(({ hospitalId, id }) => admin.removeCategory(hospitalId, id), "Category removed."),

    // Question bank
    listQuestions: route(({ req, hospitalId }) => admin.listQuestions(hospitalId, {
        categoryId: num(req.query.categoryId),
        typeId: num(req.query.typeId),
        search: typeof req.query.search === "string" ? req.query.search : undefined,
        includeInactive: req.query.includeInactive === "true",
    })),
    createQuestion: route(({ req, hospitalId, userId }) => admin.createQuestion(hospitalId, userId, req.body ?? {}), "Question added.", 201),
    updateQuestion: route(({ req, hospitalId, userId, id }) => admin.updateQuestion(hospitalId, userId, id, req.body ?? {}), "Question updated."),
    removeQuestion: route(({ hospitalId, id }) => admin.removeQuestion(hospitalId, id), "Question removed."),

    // Questionnaires
    list: route(({ req, hospitalId }) => admin.listQuestionnaires(hospitalId, {
        status: typeof req.query.status === "string" ? req.query.status : undefined,
        categoryId: num(req.query.categoryId),
    })),
    get: route(({ hospitalId, id }) => admin.getQuestionnaire(hospitalId, id)),
    create: route(({ req, hospitalId, userId }) => admin.createQuestionnaire(hospitalId, userId, req.body ?? {}), "Questionnaire created.", 201),
    update: route(({ req, hospitalId, userId, id }) => admin.updateQuestionnaire(hospitalId, userId, id, req.body ?? {}), "Questionnaire saved."),
    remove: route(({ hospitalId, id }) => admin.remove(hospitalId, id), "Questionnaire deleted."),
    publish: route(({ hospitalId, id }) => admin.publish(hospitalId, id), "Questionnaire published."),
    close: route(({ hospitalId, id }) => admin.close(hospitalId, id), "Questionnaire closed."),
    duplicate: route(({ hospitalId, userId, id }) => admin.duplicate(hospitalId, userId, id), "Questionnaire duplicated.", 201),
    sendPreview: route(({ hospitalId, id }) => admin.sendPreview(hospitalId, id)),
    send: route(({ req, hospitalId, userId, id }) => admin.send(hospitalId, userId, id, req.body ?? {}), "Questionnaire sent."),

    // One patient, for any staff member at the hospital (front desk, doctors, admins).
    forPatient: route(({ req, hospitalId }) => admin.forPatient(hospitalId, String(req.params.patientId || "").trim()), "Questionnaires fetched.", 200, "staff"),
    sendToPatient: route(
        ({ req, hospitalId, userId, id }) =>
            admin.sendToPatient(hospitalId, userId, id, String(req.body?.patientId || "").trim(), { dueInDays: req.body?.dueInDays }),
        "Questionnaire sent.",
        201,
        "staff"
    ),

    // Submissions
    listSubmissions: route(({ req, hospitalId }) => admin.listSubmissions(hospitalId, {
        questionnaireId: num(req.query.questionnaireId),
        from: typeof req.query.from === "string" ? req.query.from : undefined,
        to: typeof req.query.to === "string" ? req.query.to : undefined,
        page: num(req.query.page),
        limit: num(req.query.limit),
    })),
    getSubmission: route(({ hospitalId, id }) => admin.getSubmission(hospitalId, id)),

    // Analytics
    kpis: route(({ req, hospitalId }) => analytics.kpis(hospitalId, filterOf(req))),
    breakdown: route(({ req, hospitalId }) => analytics.breakdown(hospitalId, filterOf(req))),
    trends: route(({ req, hospitalId }) => analytics.trends(hospitalId, { ...filterOf(req), interval: req.query.interval === "month" ? "month" : "week" })),
    exportCsv: route(async ({ req, res, hospitalId }) => {
        const { fileName, csv } = await analytics.exportCsv(hospitalId, filterOf(req));
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.send(csv);
    }),
    latestInsights: route(({ req, hospitalId }) => ai.latest(hospitalId, num(req.query.questionnaireId))),
    generateInsights: route(({ req, hospitalId, userId }) => ai.generate(hospitalId, userId, { ...filterOf(req), ...pickFilter(req.body) }), "Insights ready."),
};

/** Filters may also come in the body of a POST. */
function pickFilter(body: any): Partial<AnalyticsFilter> {
    if (!body || typeof body !== "object") return {};
    const out: Partial<AnalyticsFilter> = {};
    if (num(body.questionnaireId)) out.questionnaireId = num(body.questionnaireId);
    if (typeof body.from === "string") out.from = body.from;
    if (typeof body.to === "string") out.to = body.to;
    if (typeof body.gender === "string" && body.gender !== "All") out.gender = body.gender;
    return out;
}
