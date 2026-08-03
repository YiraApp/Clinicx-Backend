/**
 * Request DTO for setting/creating a Default Organization configuration.
 */
export interface CreateDefaultOrganizationRequest {
    OrganizationId: number;
    HospitalId: number;
    IsDefault?: boolean;
    Status?: boolean;
    CreatedBy?: string;
}
