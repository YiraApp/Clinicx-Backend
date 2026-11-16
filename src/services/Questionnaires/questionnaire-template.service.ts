import { AppDataSource } from "../../config/database.js";
import { QuestionnaireError, loadForm, organizationOf } from "./questionnaire-shared.js";
import { cleanTemplate, type CleanTemplateQuestion, type TemplateInput } from "./questionnaire-template-input.js";

/**
 * A doctor's own questionnaires ("templates"): made from the send dialog, with questions written
 * for them. They belong to one doctor at one hospital (Questionnaires.OwnerUserId), are ready to
 * send as soon as they're saved, and stay out of the hospital's admin list and question bank.
 * Patients see one only after it's sent to them.
 */
export class QuestionnaireTemplateService {
    private check(input: TemplateInput, requireQuestions = true) {
        const result = cleanTemplate(input, requireQuestions);
        if (!result.ok) throw new QuestionnaireError(result.error);
        return result.value;
    }

    /** The template, if it is this doctor's at this hospital. */
    private async own(hospitalId: number, userId: string, id: number) {
        const [row] = await AppDataSource.query(
            `SELECT f.*, (SELECT COUNT(*) FROM QuestionnaireSubmissions s WHERE s.QuestionnaireId = f.Id AND s.IsDeleted = 0) AS SubmissionCount
             FROM Questionnaires f
             WHERE f.Id = @0 AND f.HospitalId = @1 AND f.OwnerUserId = @2 AND f.IsDeleted = 0 AND f.Status = 'Published'`,
            [id, hospitalId, userId]
        );
        if (!row) throw new QuestionnaireError("Questionnaire not found.", 404);
        return row;
    }

    async listMine(hospitalId: number, userId: string) {
        const rows = await AppDataSource.query(
            `SELECT f.Id, f.Title, f.Description, f.AllowMultiple, f.CreatedAt, f.UpdatedAt,
                    (SELECT COUNT(*) FROM QuestionnaireItems i WHERE i.QuestionnaireId = f.Id AND i.IsDeleted = 0) AS QuestionCount,
                    (SELECT COUNT(*) FROM QuestionnaireAssignments a WHERE a.QuestionnaireId = f.Id AND a.IsDeleted = 0) AS SentCount,
                    (SELECT COUNT(*) FROM QuestionnaireSubmissions s WHERE s.QuestionnaireId = f.Id AND s.IsDeleted = 0) AS SubmissionCount
             FROM Questionnaires f
             WHERE f.HospitalId = @0 AND f.OwnerUserId = @1 AND f.IsDeleted = 0 AND f.Status = 'Published'
             ORDER BY f.UpdatedAt DESC`,
            [hospitalId, userId]
        );
        return rows.map((r: any) => ({
            id: r.Id,
            title: r.Title,
            description: r.Description ?? null,
            allowMultiple: !!r.AllowMultiple,
            questionCount: r.QuestionCount,
            sentCount: r.SentCount,
            submissionCount: r.SubmissionCount,
            createdAt: r.CreatedAt,
            updatedAt: r.UpdatedAt,
        }));
    }

    /** The template in the shape the editor sends back. Questions are locked once a patient has answered. */
    async getMine(hospitalId: number, userId: string, id: number) {
        const row = await this.own(hospitalId, userId, id);
        const form = await loadForm(id, hospitalId);
        return {
            id: form.id,
            title: form.title,
            description: form.description,
            allowMultiple: form.allowMultiple,
            submissionCount: row.SubmissionCount,
            questionsLocked: row.SubmissionCount > 0,
            questions: form.questions.map((q) => ({
                text: q.text,
                typeCode: q.typeCode,
                helpText: q.helpText,
                isRequired: q.isRequired,
                options: q.options.map((o) => o.label),
                minValue: q.minValue,
                maxValue: q.maxValue,
            })),
        };
    }

    private async typeIds() {
        const rows = await AppDataSource.query(`SELECT Id, Code, IsActive FROM QuestionTypes`);
        return new Map<string, { id: number; active: boolean }>(rows.map((r: any) => [String(r.Code), { id: r.Id, active: !!r.IsActive }]));
    }

    /** Writes [questions] as the template's own, replacing the ones it had. */
    private async writeQuestions(m: any, ctx: { hospitalId: number; organizationId: number | null; userId: string; questionnaireId: number }, questions: CleanTemplateQuestion[]) {
        const types = await this.typeIds();
        for (const q of questions) {
            const type = types.get(q.typeCode);
            if (!type) throw new QuestionnaireError(`"${q.text}": that kind of answer isn't available.`);
            if (!type.active) throw new QuestionnaireError(`"${q.text}": that kind of answer is turned off at the moment.`);
        }
        const old = await m.query(`SELECT QuestionId FROM QuestionnaireItems WHERE QuestionnaireId = @0 AND IsDeleted = 0`, [ctx.questionnaireId]);
        await m.query(`UPDATE QuestionnaireItems SET IsDeleted = 1, UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE()) WHERE QuestionnaireId = @0 AND IsDeleted = 0`, [ctx.questionnaireId]);
        // The old questions were this template's alone, so they go with it.
        for (const { QuestionId } of old) {
            await m.query(
                `UPDATE QuestionnaireQuestions SET IsDeleted = 1, UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE()) WHERE Id = @0 AND OwnerUserId = @1`,
                [QuestionId, ctx.userId]
            );
        }
        for (const [n, q] of questions.entries()) {
            const [row] = await m.query(
                `INSERT INTO QuestionnaireQuestions
                    (HospitalId, OrganizationId, CategoryId, QuestionTypeId, Text, HelpText, IsRequired, MinValue, MaxValue, IsActive, CreatedBy, OwnerUserId)
                 OUTPUT INSERTED.Id VALUES (@0, @1, NULL, @2, @3, @4, @5, @6, @7, 1, @8, @8)`,
                [ctx.hospitalId, ctx.organizationId, types.get(q.typeCode)!.id, q.text, q.helpText, q.isRequired ? 1 : 0, q.minValue, q.maxValue, ctx.userId]
            );
            for (const [k, label] of q.options.entries()) {
                await m.query(
                    `INSERT INTO QuestionnaireQuestionOptions (QuestionId, Label, OrderNo, CreatedBy) VALUES (@0, @1, @2, @3)`,
                    [row.Id, label, k + 1, ctx.userId]
                );
            }
            await m.query(
                `INSERT INTO QuestionnaireItems (QuestionnaireId, QuestionId, OrderNo, IsRequired, CreatedBy) VALUES (@0, @1, @2, @3, @4)`,
                [ctx.questionnaireId, row.Id, n + 1, q.isRequired ? 1 : 0, ctx.userId]
            );
        }
    }

    async createMine(hospitalId: number, userId: string, input: TemplateInput) {
        const value = this.check(input);
        const organizationId = await organizationOf(hospitalId);
        const id = await AppDataSource.transaction(async (m) => {
            const [row] = await m.query(
                `INSERT INTO Questionnaires
                    (HospitalId, OrganizationId, CategoryId, Title, Description, TargetGender, AllowMultiple, RepeatAfterDays, Status, PublishedAt, CreatedBy, OwnerUserId)
                 OUTPUT INSERTED.Id
                 VALUES (@0, @1, NULL, @2, @3, 'All', @4, NULL, 'Published', DATEADD(MINUTE, 330, GETUTCDATE()), @5, @5)`,
                [hospitalId, organizationId, value.title, value.description, value.allowMultiple ? 1 : 0, userId]
            );
            await this.writeQuestions(m, { hospitalId, organizationId, userId, questionnaireId: row.Id }, value.questions!);
            return row.Id as number;
        });
        return this.getMine(hospitalId, userId, id);
    }

    async updateMine(hospitalId: number, userId: string, id: number, input: TemplateInput) {
        const current = await this.own(hospitalId, userId, id);
        const value = this.check(input, false);
        if (value.questions && current.SubmissionCount > 0) {
            throw new QuestionnaireError("Patients have already answered this questionnaire, so its questions can't change. Make a new one instead.");
        }
        await AppDataSource.transaction(async (m) => {
            await m.query(
                `UPDATE Questionnaires SET Title = @2, Description = @3, AllowMultiple = @4, UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE())
                 WHERE Id = @0 AND OwnerUserId = @1`,
                [id, userId, value.title, value.description, value.allowMultiple ? 1 : 0]
            );
            if (value.questions) {
                await this.writeQuestions(m, { hospitalId, organizationId: current.OrganizationId ?? null, userId, questionnaireId: id }, value.questions);
            }
        });
        return this.getMine(hospitalId, userId, id);
    }

    /**
     * Takes the template off the doctor's list. One with answers is closed instead of deleted, so the
     * answers still show for the patient and the doctor. Open requests for it are withdrawn either way.
     */
    async removeMine(hospitalId: number, userId: string, id: number) {
        const current = await this.own(hospitalId, userId, id);
        await AppDataSource.transaction(async (m) => {
            await m.query(
                current.SubmissionCount > 0
                    ? `UPDATE Questionnaires SET Status = 'Closed', UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE()) WHERE Id = @0`
                    : `UPDATE Questionnaires SET IsDeleted = 1, UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE()) WHERE Id = @0`,
                [id]
            );
            await m.query(
                `UPDATE QuestionnaireAssignments SET Status = 'Withdrawn', UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE())
                 WHERE QuestionnaireId = @0 AND Status = 'Pending' AND IsDeleted = 0`,
                [id]
            );
        });
        return { id, closed: current.SubmissionCount > 0 };
    }
}

export const questionnaireTemplateService = new QuestionnaireTemplateService();
