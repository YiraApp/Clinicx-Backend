import { AppDataSource } from "../../config/database.js";
import { DefaultOrganization } from "../../models/Organizations/default-organization.model.js";

/**
 * Repository implementation for managing Default Organization records.
 */
export class DefaultOrganizationRepository {
    private repo = AppDataSource.getRepository(DefaultOrganization);

    async createDefaultOrg(data: Partial<DefaultOrganization>): Promise<DefaultOrganization> {
        const entity = this.repo.create(data);
        return await this.repo.save(entity);
    }

    async updateDefaultOrg(id: number, data: Partial<DefaultOrganization>): Promise<DefaultOrganization | null> {
        await this.repo.update(id, { ...data, UpdatedAt: new Date() });
        return await this.findById(id);
    }

    async findById(id: number): Promise<DefaultOrganization | null> {
        return await this.repo.findOne({
            where: { Id: id },
            relations: ["Organization", "Hospital"]
        });
    }

    async getActiveDefault(): Promise<DefaultOrganization | null> {
        return await this.repo.findOne({
            where: { IsDefault: true, Status: true },
            relations: ["Organization", "Hospital"],
            order: { UpdatedAt: "DESC", CreatedAt: "DESC" }
        });
    }

    async findByOrgAndHospital(orgId: number, hospitalId: number): Promise<DefaultOrganization | null> {
        return await this.repo.findOne({
            where: { OrganizationId: orgId, HospitalId: hospitalId },
            relations: ["Organization", "Hospital"]
        });
    }

    async getAll(): Promise<DefaultOrganization[]> {
        return await this.repo.find({
            relations: ["Organization", "Hospital"],
            order: { IsDefault: "DESC", CreatedAt: "DESC" }
        });
    }

    /**
     * Resets all existing default organizations so that IsDefault = false.
     * Ensures only ONE record is marked as default at any given time.
     */
    async resetAllDefaults(): Promise<void> {
        await this.repo
            .createQueryBuilder()
            .update(DefaultOrganization)
            .set({ IsDefault: false, UpdatedAt: new Date() })
            .where("IsDefault = :isDefault", { isDefault: true })
            .execute();
    }
}

export const defaultOrganizationRepository = new DefaultOrganizationRepository();
