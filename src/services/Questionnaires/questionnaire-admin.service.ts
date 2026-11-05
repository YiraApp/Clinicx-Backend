import { AppDataSource } from "../../config/database.js";
import {
    QuestionnaireError,
    answersFor,
    genderFitsSql,
    loadForm,
    memberOfHospitalSql,
    normalizeGender,
    optionalNumber,
    organizationOf,
    positiveId,
    targetGenderOf,
    text,
} from "./questionnaire-shared.js";

const bool = (value: unknown, fallback: boolean) =>
    value === undefined || value === null ? fallback : value === true || value === 1 || value === "true" || value === "1";

export interface QuestionInput {
    categoryId?: number | null;
    typeId?: number;
    text?: string;
    helpText?: string | null;
    isRequired?: boolean;
    minValue?: number | null;
    maxValue?: number | null;
    isActive?: boolean;
    /** Existing options carry their id; new ones don't. Options left out are removed. */
    options?: Array<{ id?: number; label: string }>;
}

export interface QuestionnaireInput {
    categoryId?: number | null;
    title?: string;
    description?: string | null;
    targetGender?: string;
    allowMultiple?: boolean;
    repeatAfterDays?: number | null;
    items?: Array<{ questionId: number; isRequired?: boolean }>;
}

export class QuestionnaireAdminService {
    // ───────────── Question types (system master) ─────────────

    async listTypes(includeInactive = true) {
        const rows = await AppDataSource.query(
            `SELECT Id, Code, Name, HasOptions, IsActive, OrderNo FROM QuestionTypes
             ${includeInactive ? "" : "WHERE IsActive = 1"} ORDER BY OrderNo, Id`
        );
        return rows.map((r: any) => ({ id: r.Id, code: r.Code, name: r.Name, hasOptions: !!r.HasOptions, isActive: !!r.IsActive }));
    }

    async updateType(id: number, input: { name?: string; isActive?: boolean }) {
        const name = text(input.name, 100, "Name");
        const result = await AppDataSource.query(
            `UPDATE QuestionTypes SET Name = COALESCE(@1, Name), IsActive = COALESCE(@2, IsActive), UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE())
             OUTPUT INSERTED.Id WHERE Id = @0`,
            [id, name, input.isActive === undefined ? null : input.isActive ? 1 : 0]
        );
        if (!result.length) throw new QuestionnaireError("Question type not found.", 404);
        return (await this.listTypes()).find((t: any) => t.id === id);
    }

    // ───────────── Categories ─────────────

    async listCategories(hospitalId: number) {
        const rows = await AppDataSource.query(
            `SELECT c.Id, c.Name, c.Description, c.IsActive, c.CreatedAt,
                    (SELECT COUNT(*) FROM QuestionnaireQuestions q WHERE q.CategoryId = c.Id AND q.IsDeleted = 0) AS QuestionCount,
                    (SELECT COUNT(*) FROM Questionnaires f WHERE f.CategoryId = c.Id AND f.IsDeleted = 0) AS QuestionnaireCount
             FROM QuestionnaireCategories c
             WHERE c.HospitalId = @0 AND c.IsDeleted = 0
             ORDER BY c.Name`,
            [hospitalId]
        );
        return rows.map((r: any) => ({
            id: r.Id,
            name: r.Name,
            description: r.Description ?? null,
            isActive: !!r.IsActive,
            questionCount: r.QuestionCount,
            questionnaireCount: r.QuestionnaireCount,
        }));
    }

    private async assertCategoryNameFree(hospitalId: number, name: string, ownId?: number) {
        const rows = await AppDataSource.query(
            `SELECT Id FROM QuestionnaireCategories WHERE HospitalId = @0 AND Name = @1 AND IsDeleted = 0`,
            [hospitalId, name]
        );
        if (rows.some((r: any) => r.Id !== ownId)) throw new QuestionnaireError("A category with that name already exists.");
    }

    async createCategory(hospitalId: number, userId: string, input: { name?: string; description?: string | null; isActive?: boolean }) {
        const name = text(input.name, 150, "Category name", true)!;
        await this.assertCategoryNameFree(hospitalId, name);
        const organizationId = await organizationOf(hospitalId);
        const [row] = await AppDataSource.query(
            `INSERT INTO QuestionnaireCategories (HospitalId, OrganizationId, Name, Description, IsActive, CreatedBy)
             OUTPUT INSERTED.Id VALUES (@0, @1, @2, @3, @4, @5)`,
            [hospitalId, organizationId, name, text(input.description, 500, "Description"), bool(input.isActive, true) ? 1 : 0, userId || null]
        );
        return (await this.listCategories(hospitalId)).find((c: any) => c.id === row.Id);
    }

    async updateCategory(hospitalId: number, id: number, input: { name?: string; description?: string | null; isActive?: boolean }) {
        const name = input.name === undefined ? null : text(input.name, 150, "Category name", true);
        if (name) await this.assertCategoryNameFree(hospitalId, name, id);
        const result = await AppDataSource.query(
            `UPDATE QuestionnaireCategories
             SET Name = COALESCE(@2, Name),
                 Description = CASE WHEN @3 = 1 THEN @4 ELSE Description END,
                 IsActive = COALESCE(@5, IsActive), UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE())
             OUTPUT INSERTED.Id
             WHERE Id = @0 AND HospitalId = @1 AND IsDeleted = 0`,
            [id, hospitalId, name, input.description === undefined ? 0 : 1, text(input.description, 500, "Description"),
                input.isActive === undefined ? null : input.isActive ? 1 : 0]
        );
        if (!result.length) throw new QuestionnaireError("Category not found.", 404);
        return (await this.listCategories(hospitalId)).find((c: any) => c.id === id);
    }

    async removeCategory(hospitalId: number, id: number) {
        const [use] = await AppDataSource.query(
            `SELECT (SELECT COUNT(*) FROM QuestionnaireQuestions WHERE CategoryId = @0 AND IsDeleted = 0)
                  + (SELECT COUNT(*) FROM Questionnaires WHERE CategoryId = @0 AND IsDeleted = 0) AS InUse`,
            [id]
        );
        if (use.InUse > 0) throw new QuestionnaireError("This category is in use. Move its questions and questionnaires first, or mark it inactive.");
        const result = await AppDataSource.query(
            `UPDATE QuestionnaireCategories SET IsDeleted = 1, UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE()) OUTPUT INSERTED.Id
             WHERE Id = @0 AND HospitalId = @1 AND IsDeleted = 0`,
            [id, hospitalId]
        );
        if (!result.length) throw new QuestionnaireError("Category not found.", 404);
    }

    private async assertCategory(hospitalId: number, categoryId: number | null | undefined) {
        if (categoryId == null) return null;
        const id = positiveId(categoryId, "Category");
        const rows = await AppDataSource.query(
            `SELECT Id FROM QuestionnaireCategories WHERE Id = @0 AND HospitalId = @1 AND IsDeleted = 0`,
            [id, hospitalId]
        );
        if (!rows.length) throw new QuestionnaireError("Category not found.");
        return id;
    }

    // ───────────── Question bank ─────────────

    async listQuestions(hospitalId: number, filter: { categoryId?: number; typeId?: number; search?: string; includeInactive?: boolean } = {}) {
        const params: any[] = [hospitalId];
        const where = ["q.HospitalId = @0", "q.IsDeleted = 0"];
        if (!filter.includeInactive) where.push("q.IsActive = 1");
        if (filter.categoryId) { params.push(filter.categoryId); where.push(`q.CategoryId = @${params.length - 1}`); }
        if (filter.typeId) { params.push(filter.typeId); where.push(`q.QuestionTypeId = @${params.length - 1}`); }
        if (filter.search?.trim()) { params.push(`%${filter.search.trim()}%`); where.push(`q.Text LIKE @${params.length - 1}`); }
        const rows = await AppDataSource.query(
            `SELECT q.*, t.Code AS TypeCode, t.Name AS TypeName, t.HasOptions, c.Name AS CategoryName,
                    (SELECT COUNT(*) FROM QuestionnaireAnswers a WHERE a.QuestionId = q.Id) AS AnswerCount,
                    (SELECT COUNT(*) FROM QuestionnaireItems i JOIN Questionnaires f ON f.Id = i.QuestionnaireId
                      WHERE i.QuestionId = q.Id AND i.IsDeleted = 0 AND f.IsDeleted = 0) AS UsedIn
             FROM QuestionnaireQuestions q
             JOIN QuestionTypes t ON t.Id = q.QuestionTypeId
             LEFT JOIN QuestionnaireCategories c ON c.Id = q.CategoryId
             WHERE ${where.join(" AND ")}
             ORDER BY c.Name, q.Text`,
            params
        );
        const ids = rows.map((r: any) => r.Id);
        const options = ids.length
            ? await AppDataSource.query(
                `SELECT Id, QuestionId, Label, OrderNo FROM QuestionnaireQuestionOptions
                 WHERE QuestionId IN (${ids.map((_: number, n: number) => `@${n}`).join(",")}) AND IsDeleted = 0
                 ORDER BY OrderNo, Id`,
                ids
            )
            : [];
        return rows.map((r: any) => ({
            id: r.Id,
            categoryId: r.CategoryId ?? null,
            categoryName: r.CategoryName ?? null,
            typeId: r.QuestionTypeId,
            typeCode: r.TypeCode,
            typeName: r.TypeName,
            hasOptions: !!r.HasOptions,
            text: r.Text,
            helpText: r.HelpText ?? null,
            isRequired: !!r.IsRequired,
            minValue: r.MinValue ?? null,
            maxValue: r.MaxValue ?? null,
            isActive: !!r.IsActive,
            answerCount: r.AnswerCount,
            usedIn: r.UsedIn,
            options: options
                .filter((o: any) => o.QuestionId === r.Id)
                .map((o: any) => ({ id: o.Id, label: o.Label, order: o.OrderNo })),
        }));
    }

    private async typeOf(typeId: unknown) {
        const id = positiveId(typeId, "Question type");
        const [type] = await AppDataSource.query(`SELECT Id, Code, HasOptions, IsActive FROM QuestionTypes WHERE Id = @0`, [id]);
        if (!type) throw new QuestionnaireError("Question type not found.");
        return type as { Id: number; Code: string; HasOptions: boolean; IsActive: boolean };
    }

    private cleanOptions(options: QuestionInput["options"], hasOptions: boolean) {
        if (!hasOptions) return [];
        const list = (options ?? [])
            .map((o) => ({ id: o?.id ? Number(o.id) : undefined, label: String(o?.label ?? "").trim() }))
            .filter((o) => o.label);
        if (list.length < 2) throw new QuestionnaireError("Add at least two options.");
        if (list.length > 50) throw new QuestionnaireError("A question can have up to 50 options.");
        const seen = new Set<string>();
        for (const o of list) {
            if (o.label.length > 500) throw new QuestionnaireError("Options must be 500 characters or fewer.");
            const key = o.label.toLowerCase();
            if (seen.has(key)) throw new QuestionnaireError(`"${o.label}" is listed twice.`);
            seen.add(key);
        }
        return list;
    }

    private range(input: QuestionInput, code: string) {
        let min = optionalNumber(input.minValue, "Minimum");
        let max = optionalNumber(input.maxValue, "Maximum");
        if (code === "RATING") { min = 1; max = 5; }
        if (code !== "NUMBER" && code !== "RATING") { min = null; max = null; }
        if (min != null && max != null && min > max) throw new QuestionnaireError("Minimum can't be more than maximum.");
        return { min, max };
    }

    async createQuestion(hospitalId: number, userId: string, input: QuestionInput) {
        const type = await this.typeOf(input.typeId);
        if (!type.IsActive) throw new QuestionnaireError("That question type is turned off.");
        const questionText = text(input.text, 1000, "Question", true)!;
        const categoryId = await this.assertCategory(hospitalId, input.categoryId);
        const options = this.cleanOptions(input.options, !!type.HasOptions);
        const { min, max } = this.range(input, type.Code);
        const organizationId = await organizationOf(hospitalId);

        const id = await AppDataSource.transaction(async (m) => {
            const [row] = await m.query(
                `INSERT INTO QuestionnaireQuestions
                    (HospitalId, OrganizationId, CategoryId, QuestionTypeId, Text, HelpText, IsRequired, MinValue, MaxValue, IsActive, CreatedBy)
                 OUTPUT INSERTED.Id VALUES (@0, @1, @2, @3, @4, @5, @6, @7, @8, @9, @10)`,
                [hospitalId, organizationId, categoryId, type.Id, questionText, text(input.helpText, 1000, "Help text"),
                    bool(input.isRequired, false) ? 1 : 0, min, max, bool(input.isActive, true) ? 1 : 0, userId || null]
            );
            for (const [n, o] of options.entries()) {
                await m.query(
                    `INSERT INTO QuestionnaireQuestionOptions (QuestionId, Label, OrderNo, CreatedBy) VALUES (@0, @1, @2, @3)`,
                    [row.Id, o.label, n + 1, userId || null]
                );
            }
            return row.Id as number;
        });
        return (await this.listQuestions(hospitalId, { includeInactive: true })).find((q: any) => q.id === id);
    }

    async updateQuestion(hospitalId: number, userId: string, id: number, input: QuestionInput) {
        const [current] = await AppDataSource.query(
            `SELECT q.*, (SELECT COUNT(*) FROM QuestionnaireAnswers a WHERE a.QuestionId = q.Id) AS AnswerCount
             FROM QuestionnaireQuestions q WHERE q.Id = @0 AND q.HospitalId = @1 AND q.IsDeleted = 0`,
            [id, hospitalId]
        );
        if (!current) throw new QuestionnaireError("Question not found.", 404);
        const typeId = input.typeId ?? current.QuestionTypeId;
        if (Number(typeId) !== current.QuestionTypeId && current.AnswerCount > 0) {
            throw new QuestionnaireError("Patients have answered this question, so its type can't change. Add a new question instead.");
        }
        const type = await this.typeOf(typeId);
        const questionText = input.text === undefined ? current.Text : text(input.text, 1000, "Question", true);
        const categoryId = input.categoryId === undefined ? current.CategoryId : await this.assertCategory(hospitalId, input.categoryId);
        const { min, max } = this.range(
            { minValue: input.minValue === undefined ? current.MinValue : input.minValue, maxValue: input.maxValue === undefined ? current.MaxValue : input.maxValue },
            type.Code
        );
        const options = input.options === undefined ? null : this.cleanOptions(input.options, !!type.HasOptions);

        await AppDataSource.transaction(async (m) => {
            await m.query(
                `UPDATE QuestionnaireQuestions SET CategoryId = @2, QuestionTypeId = @3, Text = @4,
                    HelpText = @5, IsRequired = @6, MinValue = @7, MaxValue = @8, IsActive = @9, UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE())
                 WHERE Id = @0 AND HospitalId = @1`,
                [id, hospitalId, categoryId, type.Id, questionText,
                    input.helpText === undefined ? current.HelpText : text(input.helpText, 1000, "Help text"),
                    (input.isRequired === undefined ? !!current.IsRequired : bool(input.isRequired, false)) ? 1 : 0,
                    min, max, (input.isActive === undefined ? !!current.IsActive : bool(input.isActive, true)) ? 1 : 0]
            );
            if (options) {
                const existing = await m.query(`SELECT Id FROM QuestionnaireQuestionOptions WHERE QuestionId = @0 AND IsDeleted = 0`, [id]);
                const keep = new Set(options.filter((o) => o.id).map((o) => o.id));
                // Removed options are soft-deleted so past answers still read correctly.
                for (const row of existing) {
                    if (!keep.has(row.Id)) {
                        await m.query(`UPDATE QuestionnaireQuestionOptions SET IsDeleted = 1, UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE()) WHERE Id = @0`, [row.Id]);
                    }
                }
                for (const [n, o] of options.entries()) {
                    if (o.id && existing.some((r: any) => r.Id === o.id)) {
                        await m.query(
                            `UPDATE QuestionnaireQuestionOptions SET Label = @1, OrderNo = @2, UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE()) WHERE Id = @0`,
                            [o.id, o.label, n + 1]
                        );
                    } else {
                        await m.query(
                            `INSERT INTO QuestionnaireQuestionOptions (QuestionId, Label, OrderNo, CreatedBy) VALUES (@0, @1, @2, @3)`,
                            [id, o.label, n + 1, userId || null]
                        );
                    }
                }
            }
        });
        return (await this.listQuestions(hospitalId, { includeInactive: true })).find((q: any) => q.id === id);
    }

    async removeQuestion(hospitalId: number, id: number) {
        const [use] = await AppDataSource.query(
            `SELECT COUNT(*) AS N FROM QuestionnaireItems i JOIN Questionnaires f ON f.Id = i.QuestionnaireId
             WHERE i.QuestionId = @0 AND i.IsDeleted = 0 AND f.IsDeleted = 0 AND f.Status <> 'Closed'`,
            [id]
        );
        if (use.N > 0) throw new QuestionnaireError("This question is on a draft or published questionnaire. Remove it there first, or mark it inactive.");
        const result = await AppDataSource.query(
            `UPDATE QuestionnaireQuestions SET IsDeleted = 1, UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE()) OUTPUT INSERTED.Id
             WHERE Id = @0 AND HospitalId = @1 AND IsDeleted = 0`,
            [id, hospitalId]
        );
        if (!result.length) throw new QuestionnaireError("Question not found.", 404);
    }

    // ───────────── Questionnaires ─────────────

    async listQuestionnaires(hospitalId: number, filter: { status?: string; categoryId?: number } = {}) {
        const params: any[] = [hospitalId];
        const where = ["f.HospitalId = @0", "f.IsDeleted = 0"];
        if (filter.status) { params.push(filter.status); where.push(`f.Status = @${params.length - 1}`); }
        if (filter.categoryId) { params.push(filter.categoryId); where.push(`f.CategoryId = @${params.length - 1}`); }
        const rows = await AppDataSource.query(
            `SELECT f.*, c.Name AS CategoryName,
                (SELECT COUNT(*) FROM QuestionnaireItems i WHERE i.QuestionnaireId = f.Id AND i.IsDeleted = 0) AS QuestionCount,
                (SELECT COUNT(*) FROM QuestionnaireSubmissions s WHERE s.QuestionnaireId = f.Id AND s.IsDeleted = 0) AS SubmissionCount,
                (SELECT COUNT(DISTINCT s.PatientUserId) FROM QuestionnaireSubmissions s WHERE s.QuestionnaireId = f.Id AND s.IsDeleted = 0) AS RespondentCount,
                (SELECT COUNT(*) FROM QuestionnaireAssignments a WHERE a.QuestionnaireId = f.Id AND a.IsDeleted = 0) AS SentCount,
                (SELECT COUNT(*) FROM QuestionnaireAssignments a WHERE a.QuestionnaireId = f.Id AND a.IsDeleted = 0 AND a.Status = 'Pending') AS PendingCount,
                (SELECT MAX(s.SubmittedAt) FROM QuestionnaireSubmissions s WHERE s.QuestionnaireId = f.Id AND s.IsDeleted = 0) AS LastSubmittedAt
             FROM Questionnaires f
             LEFT JOIN QuestionnaireCategories c ON c.Id = f.CategoryId
             WHERE ${where.join(" AND ")}
             ORDER BY CASE f.Status WHEN 'Published' THEN 0 WHEN 'Draft' THEN 1 ELSE 2 END, f.UpdatedAt DESC`,
            params
        );
        return rows.map((r: any) => ({
            id: r.Id,
            categoryId: r.CategoryId ?? null,
            categoryName: r.CategoryName ?? null,
            title: r.Title,
            description: r.Description ?? null,
            targetGender: r.TargetGender,
            allowMultiple: !!r.AllowMultiple,
            repeatAfterDays: r.RepeatAfterDays ?? null,
            status: r.Status,
            publishedAt: r.PublishedAt ?? null,
            createdAt: r.CreatedAt,
            updatedAt: r.UpdatedAt,
            questionCount: r.QuestionCount,
            submissionCount: r.SubmissionCount,
            respondentCount: r.RespondentCount,
            sentCount: r.SentCount,
            pendingCount: r.PendingCount,
            lastSubmittedAt: r.LastSubmittedAt ?? null,
        }));
    }

    async getQuestionnaire(hospitalId: number, id: number) {
        const form = await loadForm(id, hospitalId);
        const summary = (await this.listQuestionnaires(hospitalId)).find((q: any) => q.id === id);
        return { ...summary, ...form };
    }

    private async cleanItems(hospitalId: number, items: QuestionnaireInput["items"]) {
        const list = (items ?? []).map((i) => ({ questionId: positiveId(i?.questionId, "Question"), isRequired: i?.isRequired }));
        const ids = [...new Set(list.map((i) => i.questionId))];
        if (ids.length !== list.length) throw new QuestionnaireError("A question is added twice.");
        if (list.length > 200) throw new QuestionnaireError("A questionnaire can have up to 200 questions.");
        if (!ids.length) return [];
        const rows = await AppDataSource.query(
            `SELECT Id, IsRequired FROM QuestionnaireQuestions
             WHERE HospitalId = @0 AND IsDeleted = 0 AND Id IN (${ids.map((_, n) => `@${n + 1}`).join(",")})`,
            [hospitalId, ...ids]
        );
        if (rows.length !== ids.length) throw new QuestionnaireError("Some questions weren't found in this hospital's question bank.");
        const required = new Map<number, boolean>(rows.map((r: any) => [r.Id, !!r.IsRequired]));
        return list.map((i) => ({ questionId: i.questionId, isRequired: i.isRequired === undefined ? required.get(i.questionId)! : !!i.isRequired }));
    }

    private settings(input: QuestionnaireInput, current?: any) {
        const allowMultiple = input.allowMultiple === undefined ? (current ? !!current.AllowMultiple : true) : bool(input.allowMultiple, true);
        let repeat = input.repeatAfterDays === undefined ? current?.RepeatAfterDays ?? null : optionalNumber(input.repeatAfterDays, "Repeat after days");
        if (repeat != null && (!Number.isInteger(repeat) || repeat < 1 || repeat > 3650)) {
            throw new QuestionnaireError("Repeat after days must be a whole number from 1 to 3650.");
        }
        if (!allowMultiple) repeat = null;
        return { allowMultiple, repeat };
    }

    async createQuestionnaire(hospitalId: number, userId: string, input: QuestionnaireInput) {
        const title = text(input.title, 200, "Title", true)!;
        const categoryId = await this.assertCategory(hospitalId, input.categoryId);
        const targetGender = targetGenderOf(input.targetGender);
        const { allowMultiple, repeat } = this.settings(input);
        const items = await this.cleanItems(hospitalId, input.items);
        const organizationId = await organizationOf(hospitalId);
        const id = await AppDataSource.transaction(async (m) => {
            const [row] = await m.query(
                `INSERT INTO Questionnaires (HospitalId, OrganizationId, CategoryId, Title, Description, TargetGender, AllowMultiple, RepeatAfterDays, CreatedBy)
                 OUTPUT INSERTED.Id VALUES (@0, @1, @2, @3, @4, @5, @6, @7, @8)`,
                [hospitalId, organizationId, categoryId, title, text(input.description, 2000, "Description"), targetGender,
                    allowMultiple ? 1 : 0, repeat, userId || null]
            );
            await this.writeItems(m, row.Id, items, userId);
            return row.Id as number;
        });
        return this.getQuestionnaire(hospitalId, id);
    }

    private async writeItems(m: any, questionnaireId: number, items: Array<{ questionId: number; isRequired: boolean }>, userId: string) {
        await m.query(`UPDATE QuestionnaireItems SET IsDeleted = 1, UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE()) WHERE QuestionnaireId = @0 AND IsDeleted = 0`, [questionnaireId]);
        for (const [n, item] of items.entries()) {
            await m.query(
                `INSERT INTO QuestionnaireItems (QuestionnaireId, QuestionId, OrderNo, IsRequired, CreatedBy) VALUES (@0, @1, @2, @3, @4)`,
                [questionnaireId, item.questionId, n + 1, item.isRequired ? 1 : 0, userId || null]
            );
        }
    }

    private async current(hospitalId: number, id: number) {
        const [row] = await AppDataSource.query(
            `SELECT * FROM Questionnaires WHERE Id = @0 AND HospitalId = @1 AND IsDeleted = 0`,
            [id, hospitalId]
        );
        if (!row) throw new QuestionnaireError("Questionnaire not found.", 404);
        return row;
    }

    async updateQuestionnaire(hospitalId: number, userId: string, id: number, input: QuestionnaireInput) {
        const current = await this.current(hospitalId, id);
        if (current.Status === "Closed") throw new QuestionnaireError("This questionnaire is closed. Duplicate it to make a new version.");
        // Once published, patients may be answering it: only the wording around it can change.
        if (current.Status === "Published" && (input.items !== undefined || input.targetGender !== undefined)) {
            throw new QuestionnaireError("A published questionnaire's questions and audience are locked. Close it and duplicate it to change them.");
        }
        const title = input.title === undefined ? current.Title : text(input.title, 200, "Title", true);
        const categoryId = input.categoryId === undefined ? current.CategoryId : await this.assertCategory(hospitalId, input.categoryId);
        const targetGender = input.targetGender === undefined ? current.TargetGender : targetGenderOf(input.targetGender);
        const { allowMultiple, repeat } = this.settings(input, current);
        const items = input.items === undefined ? null : await this.cleanItems(hospitalId, input.items);
        await AppDataSource.transaction(async (m) => {
            await m.query(
                `UPDATE Questionnaires SET Title = @2, CategoryId = @3, Description = @4, TargetGender = @5,
                    AllowMultiple = @6, RepeatAfterDays = @7, UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE())
                 WHERE Id = @0 AND HospitalId = @1`,
                [id, hospitalId, title, categoryId,
                    input.description === undefined ? current.Description : text(input.description, 2000, "Description"),
                    targetGender, allowMultiple ? 1 : 0, repeat]
            );
            if (items) await this.writeItems(m, id, items, userId);
        });
        return this.getQuestionnaire(hospitalId, id);
    }

    async publish(hospitalId: number, id: number) {
        const current = await this.current(hospitalId, id);
        if (current.Status === "Published") return this.getQuestionnaire(hospitalId, id);
        if (current.Status === "Closed") throw new QuestionnaireError("This questionnaire is closed. Duplicate it to publish a new version.");
        const form = await loadForm(id, hospitalId);
        if (!form.questions.length) throw new QuestionnaireError("Add at least one question before publishing.");
        const broken = form.questions.find((q) => ["SINGLE_CHOICE", "MULTI_CHOICE", "DROPDOWN"].includes(q.typeCode) && q.options.length < 2);
        if (broken) throw new QuestionnaireError(`"${broken.text}" needs at least two options.`);
        await AppDataSource.query(
            `UPDATE Questionnaires SET Status = 'Published', PublishedAt = DATEADD(MINUTE, 330, GETUTCDATE()), UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE()) WHERE Id = @0`,
            [id]
        );
        return this.getQuestionnaire(hospitalId, id);
    }

    async close(hospitalId: number, id: number) {
        await this.current(hospitalId, id);
        await AppDataSource.transaction(async (m) => {
            await m.query(`UPDATE Questionnaires SET Status = 'Closed', UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE()) WHERE Id = @0`, [id]);
            // Nobody can answer a closed questionnaire, so open requests are withdrawn.
            await m.query(
                `UPDATE QuestionnaireAssignments SET Status = 'Withdrawn', UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE())
                 WHERE QuestionnaireId = @0 AND Status = 'Pending' AND IsDeleted = 0`,
                [id]
            );
        });
        return this.getQuestionnaire(hospitalId, id);
    }

    async duplicate(hospitalId: number, userId: string, id: number) {
        const current = await this.current(hospitalId, id);
        const form = await loadForm(id, hospitalId);
        return this.createQuestionnaire(hospitalId, userId, {
            categoryId: current.CategoryId,
            title: `${current.Title} (copy)`.slice(0, 200),
            description: current.Description,
            targetGender: current.TargetGender,
            allowMultiple: !!current.AllowMultiple,
            repeatAfterDays: current.RepeatAfterDays,
            items: form.questions.map((q) => ({ questionId: q.id, isRequired: q.isRequired })),
        });
    }

    async remove(hospitalId: number, id: number) {
        const current = await this.current(hospitalId, id);
        const [subs] = await AppDataSource.query(
            `SELECT COUNT(*) AS N FROM QuestionnaireSubmissions WHERE QuestionnaireId = @0 AND IsDeleted = 0`,
            [id]
        );
        if (subs.N > 0 || current.Status === "Published") {
            throw new QuestionnaireError("Patients have this questionnaire or its answers. Close it instead of deleting it.");
        }
        await AppDataSource.query(`UPDATE Questionnaires SET IsDeleted = 1, UpdatedAt = DATEADD(MINUTE, 330, GETUTCDATE()) WHERE Id = @0`, [id]);
    }

    // ───────────── Sending ─────────────

    /**
     * Patients of the hospital the questionnaire is for, by gender, leaving out
     * anyone who already has an open request for it, and, when it can only be
     * answered once, anyone who already answered.
     */
    private eligibleSql() {
        return `
            SELECT u.Id
            FROM Users u
            CROSS JOIN (SELECT * FROM Questionnaires WHERE Id = @0) f
            WHERE u.IsDeleted = 0
              AND ${memberOfHospitalSql("u.Id", "f.HospitalId")}
              AND ${genderFitsSql("u.Gender", "f.TargetGender")}
              AND NOT EXISTS (SELECT 1 FROM QuestionnaireAssignments qa
                              WHERE qa.QuestionnaireId = f.Id AND qa.PatientUserId = u.Id AND qa.Status = 'Pending' AND qa.IsDeleted = 0)
              AND (f.AllowMultiple = 1 OR NOT EXISTS (SELECT 1 FROM QuestionnaireSubmissions qs
                              WHERE qs.QuestionnaireId = f.Id AND qs.PatientUserId = u.Id AND qs.IsDeleted = 0))`;
    }

    async sendPreview(hospitalId: number, id: number) {
        const current = await this.current(hospitalId, id);
        const [row] = await AppDataSource.query(`SELECT COUNT(*) AS N FROM (${this.eligibleSql()}) e`, [id]);
        const [all] = await AppDataSource.query(
            `SELECT COUNT(*) AS N FROM Users u WHERE u.IsDeleted = 0 AND ${memberOfHospitalSql("u.Id", "@0")}`,
            [hospitalId]
        );
        return { questionnaireId: id, status: current.Status, targetGender: current.TargetGender, recipients: row.N, hospitalPatients: all.N };
    }

    /**
     * The hospital's published questionnaires as seen for one patient, for staff choosing one to send:
     * whether it's already waiting for them, when they last filled it, and whether it fits them.
     */
    async forPatient(hospitalId: number, patientId: string) {
        const [patient] = await AppDataSource.query(
            `SELECT u.Id, LTRIM(RTRIM(ISNULL(u.FirstName, '') + ' ' + ISNULL(u.LastName, ''))) AS Name, u.Gender
             FROM Users u WHERE u.Id = @0 AND u.IsDeleted = 0 AND ${memberOfHospitalSql("u.Id", "@1")}`,
            [patientId, hospitalId]
        );
        if (!patient) throw new QuestionnaireError("This patient isn't registered at this hospital.", 404);
        const rows = await AppDataSource.query(
            `SELECT f.Id, f.Title, f.Description, f.TargetGender, f.AllowMultiple, f.RepeatAfterDays, c.Name AS CategoryName,
                    (SELECT COUNT(*) FROM QuestionnaireItems i WHERE i.QuestionnaireId = f.Id AND i.IsDeleted = 0) AS QuestionCount,
                    CASE WHEN ${genderFitsSql("u.Gender", "f.TargetGender")} THEN 1 ELSE 0 END AS GenderFits,
                    pa.SentAt AS PendingSentAt, pa.DueAt AS PendingDueAt, pa.SentByName,
                    ls.Attempts, ls.LastSubmittedAt
             FROM Questionnaires f
             JOIN Users u ON u.Id = @1
             LEFT JOIN QuestionnaireCategories c ON c.Id = f.CategoryId
             OUTER APPLY (SELECT TOP 1 a.SentAt, a.DueAt,
                                 NULLIF(LTRIM(RTRIM(ISNULL(LTRIM(RTRIM(s.FirstName)), '') + ' ' + ISNULL(LTRIM(RTRIM(s.LastName)), ''))), '') AS SentByName
                          FROM QuestionnaireAssignments a LEFT JOIN Users s ON s.Id = a.SentBy
                          WHERE a.QuestionnaireId = f.Id AND a.PatientUserId = @1 AND a.Status = 'Pending' AND a.IsDeleted = 0
                          ORDER BY a.SentAt DESC) pa
             OUTER APPLY (SELECT COUNT(*) AS Attempts, MAX(s.SubmittedAt) AS LastSubmittedAt FROM QuestionnaireSubmissions s
                          WHERE s.QuestionnaireId = f.Id AND s.PatientUserId = @1 AND s.IsDeleted = 0) ls
             WHERE f.HospitalId = @0 AND f.Status = 'Published' AND f.IsDeleted = 0
             ORDER BY f.Title`,
            [hospitalId, patientId]
        );
        return {
            patient: { id: patient.Id, name: patient.Name || "Patient", gender: normalizeGender(patient.Gender) },
            questionnaires: rows.map((r: any) => {
                const pending = r.PendingSentAt ? { sentAt: r.PendingSentAt, dueAt: r.PendingDueAt ?? null, sentBy: r.SentByName ?? null } : null;
                const fits = !!r.GenderFits;
                return {
                    id: r.Id,
                    title: r.Title,
                    description: r.Description ?? null,
                    categoryName: r.CategoryName ?? null,
                    questionCount: r.QuestionCount,
                    targetGender: targetGenderOf(r.TargetGender),
                    allowMultiple: !!r.AllowMultiple,
                    repeatAfterDays: r.RepeatAfterDays ?? null,
                    attempts: r.Attempts ?? 0,
                    lastSubmittedAt: r.LastSubmittedAt ?? null,
                    pending,
                    canSend: fits && !pending,
                    reason: !fits
                        ? `Only for ${targetGenderOf(r.TargetGender).toLowerCase()} patients.`
                        : pending
                            ? "Already sent and waiting for an answer."
                            : null,
                };
            }),
        };
    }

    /**
     * Sends one questionnaire to one patient, from a member of staff (front desk, doctor, admin).
     * A questionnaire meant to be filled once can be sent again; the patient then fills it again.
     */
    async sendToPatient(hospitalId: number, userId: string, id: number, patientId: string, input: { dueInDays?: number | null } = {}) {
        const current = await this.current(hospitalId, id);
        if (current.Status !== "Published") throw new QuestionnaireError("Only published questionnaires can be sent.");
        if (!patientId) throw new QuestionnaireError("Choose a patient.");
        const { patient, questionnaires } = await this.forPatient(hospitalId, patientId);
        const item = questionnaires.find((q: any) => q.id === id);
        if (!item) throw new QuestionnaireError("Questionnaire not found.", 404);
        if (!item.canSend) throw new QuestionnaireError(item.reason ?? "This questionnaire can't be sent to this patient.", 409);
        const dueInDays = optionalNumber(input.dueInDays, "Due in days");
        if (dueInDays != null && (!Number.isInteger(dueInDays) || dueInDays < 1 || dueInDays > 365)) {
            throw new QuestionnaireError("Due in days must be a whole number from 1 to 365.");
        }
        const [row] = await AppDataSource.query(
            `INSERT INTO QuestionnaireAssignments (QuestionnaireId, HospitalId, OrganizationId, PatientUserId, SentBy, SentAt, DueAt, Source)
             OUTPUT INSERTED.Id, INSERTED.SentAt, INSERTED.DueAt
             VALUES (@0, @1, @2, @3, @4, DATEADD(MINUTE, 330, GETUTCDATE()),
                     ${dueInDays ? "DATEADD(DAY, @5, DATEADD(MINUTE, 330, GETUTCDATE()))" : "NULL"}, 'Individual')`,
            dueInDays
                ? [id, hospitalId, current.OrganizationId, patientId, userId || null, dueInDays]
                : [id, hospitalId, current.OrganizationId, patientId, userId || null]
        );
        const [sender] = await AppDataSource.query(
            `SELECT NULLIF(LTRIM(RTRIM(ISNULL(LTRIM(RTRIM(FirstName)), '') + ' ' + ISNULL(LTRIM(RTRIM(LastName)), ''))), '') AS Name FROM Users WHERE Id = @0`,
            [userId]
        );
        const hospital = await AppDataSource.query(`SELECT Name FROM Hospitals WHERE Id = @0`, [hospitalId]);
        const from = sender?.Name ? `${sender.Name}${hospital[0]?.Name ? ` at ${hospital[0].Name}` : ""}` : hospital[0]?.Name || "Your hospital";
        void notifyPatients([patientId], current.Title, id, `${from} asked you to fill in "${current.Title}".`);
        return { questionnaireId: id, patientId, patientName: patient.name, assignmentId: row.Id, sentAt: row.SentAt, dueAt: row.DueAt ?? null };
    }

    /** Asks every eligible patient to fill the questionnaire. Notifications go out in the background. */
    async send(hospitalId: number, userId: string, id: number, input: { dueInDays?: number | null } = {}) {
        const current = await this.current(hospitalId, id);
        if (current.Status !== "Published") throw new QuestionnaireError("Publish the questionnaire before sending it.");
        const dueInDays = optionalNumber(input.dueInDays, "Due in days");
        if (dueInDays != null && (!Number.isInteger(dueInDays) || dueInDays < 1 || dueInDays > 365)) {
            throw new QuestionnaireError("Due in days must be a whole number from 1 to 365.");
        }
        const inserted: Array<{ PatientUserId: string }> = await AppDataSource.query(
            `INSERT INTO QuestionnaireAssignments (QuestionnaireId, HospitalId, OrganizationId, PatientUserId, SentBy, DueAt, Source)
             OUTPUT INSERTED.PatientUserId
             SELECT @0, @1, @2, e.Id, @3, ${dueInDays ? "DATEADD(DAY, @4, DATEADD(MINUTE, 330, GETUTCDATE()))" : "NULL"}, 'Manual'
             FROM (${this.eligibleSql()}) e`,
            dueInDays ? [id, hospitalId, current.OrganizationId, userId || null, dueInDays] : [id, hospitalId, current.OrganizationId, userId || null]
        );
        const patients = inserted.map((r) => String(r.PatientUserId));
        void notifyPatients(patients, current.Title, id);
        return { questionnaireId: id, sent: patients.length };
    }

    // ───────────── Submissions ─────────────

    async listSubmissions(hospitalId: number, filter: { questionnaireId?: number; from?: string; to?: string; page?: number; limit?: number } = {}) {
        const params: any[] = [hospitalId];
        const where = ["s.HospitalId = @0", "s.IsDeleted = 0"];
        if (filter.questionnaireId) { params.push(filter.questionnaireId); where.push(`s.QuestionnaireId = @${params.length - 1}`); }
        if (filter.from) { params.push(filter.from); where.push(`s.SubmittedAt >= @${params.length - 1}`); }
        if (filter.to) { params.push(filter.to); where.push(`s.SubmittedAt < DATEADD(DAY, 1, CAST(@${params.length - 1} AS DATE))`); }
        const limit = Math.min(Math.max(Number(filter.limit) || 25, 1), 200);
        const page = Math.max(Number(filter.page) || 1, 1);
        const [count] = await AppDataSource.query(`SELECT COUNT(*) AS N FROM QuestionnaireSubmissions s WHERE ${where.join(" AND ")}`, params);
        const rows = await AppDataSource.query(
            `SELECT s.Id, s.QuestionnaireId, s.AttemptNo, s.SubmittedAt, s.PatientUserId, s.PatientGender,
                    f.Title, u.FirstName, u.LastName, u.PhoneNumber
             FROM QuestionnaireSubmissions s
             JOIN Questionnaires f ON f.Id = s.QuestionnaireId
             LEFT JOIN Users u ON u.Id = s.PatientUserId
             WHERE ${where.join(" AND ")}
             ORDER BY s.SubmittedAt DESC
             OFFSET ${(page - 1) * limit} ROWS FETCH NEXT ${limit} ROWS ONLY`,
            params
        );
        return {
            total: count.N,
            page,
            limit,
            items: rows.map((r: any) => ({
                id: r.Id,
                questionnaireId: r.QuestionnaireId,
                questionnaireTitle: r.Title,
                attemptNo: r.AttemptNo,
                submittedAt: r.SubmittedAt,
                patientId: r.PatientUserId,
                patientName: `${r.FirstName ?? ""} ${r.LastName ?? ""}`.trim() || "Patient",
                patientPhone: r.PhoneNumber ?? null,
                patientGender: r.PatientGender ?? null,
            })),
        };
    }

    async getSubmission(hospitalId: number, submissionId: number) {
        const [row] = await AppDataSource.query(
            `SELECT s.*, f.Title, u.FirstName, u.LastName FROM QuestionnaireSubmissions s
             JOIN Questionnaires f ON f.Id = s.QuestionnaireId
             LEFT JOIN Users u ON u.Id = s.PatientUserId
             WHERE s.Id = @0 AND s.HospitalId = @1 AND s.IsDeleted = 0`,
            [submissionId, hospitalId]
        );
        if (!row) throw new QuestionnaireError("Submission not found.", 404);
        const answers = (await answersFor([row.Id])).get(row.Id) ?? [];
        return {
            id: row.Id,
            questionnaireId: row.QuestionnaireId,
            questionnaireTitle: row.Title,
            attemptNo: row.AttemptNo,
            submittedAt: row.SubmittedAt,
            patientId: row.PatientUserId,
            patientName: `${row.FirstName ?? ""} ${row.LastName ?? ""}`.trim() || "Patient",
            patientGender: row.PatientGender ?? null,
            answers,
        };
    }
}

/** Push and in-app notifications, a few at a time so a large hospital doesn't flood the push service. */
export async function notifyPatients(patientIds: string[], title: string, questionnaireId: number, body?: string) {
    if (!patientIds.length) return;
    try {
        const { pushNotificationService } = await import("../Notifications/push-notification.service.js");
        const queue = [...patientIds];
        const worker = async () => {
            for (let id = queue.shift(); id; id = queue.shift()) {
                try {
                    await pushNotificationService.sendNotification({
                        userId: id,
                        title: "Questionnaire",
                        body: body ?? `Please fill in "${title}".`,
                        type: "QUESTIONNAIRE",
                        referenceId: String(questionnaireId),
                        route: "/patientQuestionnaires",
                        additionalData: { questionnaireId: String(questionnaireId) },
                    });
                } catch (error: any) {
                    console.error(`[Questionnaire] notify ${id}: ${error?.message || error}`);
                }
            }
        };
        await Promise.all(Array.from({ length: 5 }, worker));
    } catch (error: any) {
        console.error(`[Questionnaire] notifications: ${error?.message || error}`);
    }
}

export const questionnaireAdminService = new QuestionnaireAdminService();
