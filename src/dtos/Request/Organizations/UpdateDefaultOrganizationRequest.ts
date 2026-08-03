/**
 * Request DTO for updating a Default Organization configuration.
 */
export interface UpdateDefaultOrganizationRequest {
    Id: number;
    OrganizationId?: number;
    HospitalId?: number;
    IsDefault?: boolean;
    Status?: boolean;
    UpdatedBy?: string;
}
