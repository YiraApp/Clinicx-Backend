import { AppDataSource } from "../../config/database.js";
import { ConsentTemplate } from "../../models/Consent/consent-template.model.js";
import { ConsentTemplateField } from "../../models/Consent/ConsentTemplateField.js";

export class ConsentTemplateRepository {
    private templateRepo = AppDataSource.getRepository(ConsentTemplate);
    private fieldRepo = AppDataSource.getRepository(ConsentTemplateField);

    async createTemplate(templateData: Partial<ConsentTemplate>, fields: Partial<ConsentTemplateField>[] = []): Promise<ConsentTemplate> {
        const template = this.templateRepo.create(templateData);
        const savedTemplate = await this.templateRepo.save(template);

        if (fields.length > 0) {
            const fieldEntities = fields.map(field => this.fieldRepo.create({
                ...field,
                Template: savedTemplate,
                TemplateId: savedTemplate.TemplateId
            }));
            await this.fieldRepo.save(fieldEntities);
        }

        return savedTemplate;
    }

    async getTemplates(hospitalId?: number, organizationId?: number): Promise<ConsentTemplate[]> {
        const query = this.templateRepo.createQueryBuilder("template")
            .leftJoinAndSelect("template.TemplateFields", "fields")
            .where("template.IsDeleted = :isDeleted", { isDeleted: false })
            .andWhere("template.Status = :status", { status: true });

        if (hospitalId) {
            query.andWhere("template.HospitalId = :hospitalId", { hospitalId });
        }

        if (organizationId) {
            query.andWhere("template.OrganizationId = :organizationId", { organizationId });
        }

        return await query.getMany();
    }

    async getTemplateById(templateId: number): Promise<ConsentTemplate | null> {
        return await this.templateRepo.findOne({
            where: { TemplateId: templateId, IsDeleted: false },
            relations: ["TemplateFields"]
        });
    }

    async softDeleteTemplate(templateId: number): Promise<void> {
        await this.templateRepo.update(templateId, {
            IsDeleted: true,
            Status: false,
            UpdatedAt: new Date()
        });
    }

    async updateTemplate(templateId: number, updateData: Partial<ConsentTemplate>, fields?: Partial<ConsentTemplateField>[]): Promise<ConsentTemplate | null> {
        const template = await this.getTemplateById(templateId);
        if (!template) return null;

        await this.templateRepo.update(templateId, {
            ...updateData,
            UpdatedAt: new Date()
        });

        if (fields) {
            await this.fieldRepo.delete({ TemplateId: templateId });

            if (fields.length > 0) {
                const cleanedFields = fields.map(field => {
                    const { FieldId, CreatedAt, ...fieldData } = field as any;
                    return { ...fieldData, TemplateId: templateId };
                });
                
                const fieldEntities = this.fieldRepo.create(cleanedFields);
                await this.fieldRepo.save(fieldEntities);
            }
        }

        return await this.getTemplateById(templateId);
    }
}

export const consentTemplateRepository = new ConsentTemplateRepository();
