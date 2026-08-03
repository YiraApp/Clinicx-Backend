import type { DefaultOrganization } from "../../../models/Organizations/default-organization.model.js";

/**
 * Response DTO for Default Organization configuration.
 */
export interface DefaultOrganizationResponse {
    Id: number;
    OrganizationId: number;
    HospitalId: number;
    OrganizationName?: string | null;
    HospitalName?: string | null;
    IsDefault: boolean;
    Status: boolean;
    CreatedAt: Date;
    UpdatedAt?: Date | null;
    CreatedBy?: string | null;
    UpdatedBy?: string | null;
}
