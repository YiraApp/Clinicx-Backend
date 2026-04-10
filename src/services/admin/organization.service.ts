import httpClient from "@/lib/httpClient";
import { API_CONFIG } from "@/config/api.config";

export interface CreateOrganizationRequest {
    Name: string;
    MobileNumber: string;
    roleId: string;
    OrgCode?: string;
    Email?: string;
    Address?: string;
    Website?: string;
    HospitalId?: number;
    OrganizationType?: string;
}

export interface OrganizationResponse {
    success: boolean;
    message: string;
    data: {
        organization: {
            Id: string;
            Name: string;
            OrgCode: string;
            Status: boolean;
            [key: string]: any;
        };
        user: {
            Id: string;
            FirstName: string;
            PhoneNumber: string;
        };
    };
}

export interface UpdateOrganizationRequest {
    Id: number | string;
    Name?: string;
    MobileNumber?: string;
    roleId?: string;
    OrgCode?: string;
    Email?: string;
    Website?: string;
    Address?: string;
    Status?: boolean | string;
    HospitalId?: number;
    OrganizationType?: string;
}

export interface OrganizationSummary {
    Id: string | number;
    Name: string;
    OrgCode: string;
    OrganizationType?: string;
    Status: boolean | string;
    Email?: string;
    MobileNumber?: string;
    Address?: string;
    Website?: string;
    CreatedAt: string;
    UserCount?: number;
    PatientCount?: number;
    [key: string]: any;
}

export interface PaginationInfo {
    page: number;
    pageSize: number;
    totalRecords: number;
    totalPages: number;
}

export interface DashboardSummaryResponse {
    totalOrganizations: number;
    activeOrganizations: number;
    totalUsers: number;
    totalPatients: number;
    pagination: PaginationInfo;
    organizationStats: OrganizationSummary[];
}

export const OrganizationService = {
    BASE_URL: API_CONFIG.ENDPOINTS.ORGANIZATIONS || "/api/organizations",

    createOrganization: async (data: CreateOrganizationRequest): Promise<any> => {
        const response = await httpClient.post(`${OrganizationService.BASE_URL}/createorg`, data);
        return response;
    },

    getOrganizations: async (page: number = 1, pageSize: number = 10): Promise<DashboardSummaryResponse> => {
        const response = await httpClient.get(`${OrganizationService.BASE_URL}/getAllOrganizations`, {
            params: { PageNumber: page, PageSize: pageSize }
        });
        return response.data;
    },

    updateOrganization: async (data: UpdateOrganizationRequest): Promise<any> => {
        const response = await httpClient.post(`${OrganizationService.BASE_URL}/updateorg`, data);
        return response;
    }
};

export default OrganizationService;
