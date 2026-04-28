import { AppDataSource } from "../../config/database.js";
import { ConsentTemplate } from "../../models/Consent/consent-template.model.js";
import { SignatureField } from "../../models/Consent/signature-field.model.js";

export class ConsentTemplateRepository {
    private templateRepo = AppDataSource.getRepository(ConsentTemplate);
    private fieldRepo = AppDataSource.getRepository(SignatureField);

    /**
     * Creates a new consent template with its signature fields.
     */
    async createTemplate(templateData: Partial<ConsentTemplate>, fields: Partial<SignatureField>[] = []): Promise<ConsentTemplate> {
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

    /**
     * Fetches templates for a specific hospital or organization.
     */
    async getTemplates(hospitalId?: number, organizationId?: number): Promise<ConsentTemplate[]> {
        const query = this.templateRepo.createQueryBuilder("template")
            .leftJoinAndSelect("template.SignatureFields", "fields")
            .where("template.IsDeleted = :isDeleted", { isDeleted: false });

        if (hospitalId) {
            query.andWhere("template.HospitalId = :hospitalId", { hospitalId });
        }

        if (organizationId) {
            query.andWhere("template.OrganizationId = :organizationId", { organizationId });
        }

        return await query.getMany();
    }

    /**
     * Gets a single template by ID.
     */
    async getTemplateById(templateId: number): Promise<ConsentTemplate | null> {
        return await this.templateRepo.findOne({
            where: { TemplateId: templateId, IsDeleted: false },
            relations: ["SignatureFields"]
        });
    }
}

export const consentTemplateRepository = new ConsentTemplateRepository();
