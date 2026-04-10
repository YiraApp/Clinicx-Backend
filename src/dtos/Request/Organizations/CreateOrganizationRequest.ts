/**
 * Request DTO for creating a new Organization.
 */
export interface CreateOrganizationRequest {
    Name: string;
    OrgCode?: string;
    OrganizationType?: string;
    Email?: string;
    MobileNumber: string;
    Address?: string;
    Website?: string;
    roleId: string;
    HospitalId?: number;
}
