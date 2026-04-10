import type { Organization } from "../../../models/Organizations/organization.model.js";

/**
 * Response DTO for organization creation.
 */
export interface CreateOrganizationResponse {
    organization: Organization;
    user: {
        Id: string;
        FirstName: string;
        PhoneNumber: string;
    };
}
