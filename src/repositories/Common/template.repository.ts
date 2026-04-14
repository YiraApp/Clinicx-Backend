import { AppDataSource } from "../../config/database.js";
import { Template } from "../../models/Common/template.model.js";

/**
 * Repository for Template entity.
 */
export class TemplateRepository {
    private repository = AppDataSource.getRepository(Template);

    /**
     * Find a template by its unique code.
     * @param templateCode The code of the template to find.
     * @returns The template if found, otherwise null.
     */
    async findByCode(templateCode: string): Promise<Template | null> {
        return await this.repository.findOne({
            where: { TemplateCode: templateCode, Status: true }
        });
    }

    /**
     * Get all active templates.
     * @returns A list of all active templates.
     */
    async getAllActive(): Promise<Template[]> {
        return await this.repository.find({
            where: { Status: true }
        });
    }
}

export const templateRepository = new TemplateRepository();
