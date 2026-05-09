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
    getAdminDashboardData(orgId?: number, hospId?: number): Promise<any>;
    getDashboardSummary(page?: number, pageSize?: number, orgId?: number, type?: string, search?: string): Promise<DashboardSummary>;
    getFrontdeskDashboardData(hospId: number): Promise<any>;
    getDoctorDashboardData(doctorId: string, hospId: number): Promise<any>;
}
