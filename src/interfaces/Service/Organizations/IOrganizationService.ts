import type { CreateOrganizationRequest } from "../../../dtos/Request/Organizations/CreateOrganizationRequest.js";
import type { CreateOrganizationResponse } from "../../../dtos/Response/Organizations/CreateOrganizationResponse.js";
import type { UpdateOrganizationRequest } from "../../../dtos/Request/Organizations/UpdateOrganizationRequest.js";
import type { Organization } from "../../../models/Organizations/organization.model.js";
import type { DashboardSummary } from "../Common/IDashboardService.js";

/**
 * Interface for Organization Service.
 */
export interface IOrganizationService {
    createOrganization(data: CreateOrganizationRequest, roleId: string): Promise<CreateOrganizationResponse>;
    updateOrganization(data: UpdateOrganizationRequest): Promise<any>;
    getAllOrganizations(page?: number, pageSize?: number, orgId?: number, type?: string, search?: string): Promise<DashboardSummary>;
}
