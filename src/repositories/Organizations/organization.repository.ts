import { AppDataSource } from "../../config/database.js";
import { Organization } from "../../models/Organizations/organization.model.js";
import type { IOrganizationRepository } from "../../interfaces/Repository/Organizations/IOrganizationRepository.js";

/**
 * Implementation of Organization Repository.
 */
export class OrganizationRepository implements IOrganizationRepository {
    private repo = AppDataSource.getRepository(Organization);

    async createOrganization(orgData: Partial<Organization>): Promise<Organization> {
        const organization = this.repo.create(orgData);
        return await this.repo.save(organization);
    }

    async findById(id: number): Promise<Organization | null> {
        return await this.repo.findOne({ where: { Id: id } });
    }

    async findByMobile(mobile: string): Promise<Organization | null> {
        return await this.repo.findOne({ where: { MobileNumber: mobile } });
    }

    async findByCode(code: string): Promise<Organization | null> {
        return await this.repo.findOne({ where: { OrgCode: code } });
    }

    async findByEmail(email: string): Promise<Organization | null> {
        return await this.repo.findOne({ where: { Email: email } });
    }

    async getAllOrganizations(): Promise<Organization[]> {
        return await this.repo.find();
    }
}

export const organizationRepository = new OrganizationRepository();
