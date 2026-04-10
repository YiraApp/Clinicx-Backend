import { Organization } from "../../../models/Organizations/organization.model.js";

export interface PaginationInfo {
    page: number;
    pageSize: number;
    totalRecords: number;
    totalPages: number;
}

export interface DashboardSummary {
    totalOrganizations: number;
    activeOrganizations: number;
    totalUsers: number;
    totalPatients: number;
    pagination: PaginationInfo;
    organizationStats: any[];
}

export interface IDashboardService {
    getDashboardSummary(page?: number, pageSize?: number): Promise<DashboardSummary>;
}
