import { Organization } from "../../../models/Organizations/organization.model.js";

/**
 * Interface for Organization Repository.
 */
export interface IOrganizationRepository {
    createOrganization(orgData: Partial<Organization>): Promise<Organization>;
    findById(id: number): Promise<Organization | null>;
    findByMobile(mobile: string): Promise<Organization | null>;
    findByCode(code: string): Promise<Organization | null>;
    findByEmail(email: string): Promise<Organization | null>;
    getAllOrganizations(): Promise<Organization[]>;
}
