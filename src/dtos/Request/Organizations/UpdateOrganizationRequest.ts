/**
 * Request DTO for updating an existing Organization.
 */
export interface UpdateOrganizationRequest {
    Id: number;
    Name?: string;
    OrgCode?: string;
    OrganizationType?: string;
    Email?: string;
    MobileNumber?: string;
    CountryCode?: string;

    Address?: string;
    Website?: string;
    Status?: boolean;
    roleId?: string; // Admin role to assign if MobileNumber changes
    HospitalId?: number;
}
