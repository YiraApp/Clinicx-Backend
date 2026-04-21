import { dashboardRepository } from "../../repositories/Common/dashboard.repository.js";
import type { DashboardSummary, IDashboardService } from "../../interfaces/Service/Common/IDashboardService.js";

export class DashboardService implements IDashboardService {
    async getAdminDashboardData(orgId?: number) {
        return await dashboardRepository.getAdminDashboardStats(orgId);
    }

    async getDashboardSummary(page?: number, pageSize?: number, orgId?: number, type?: string, search?: string): Promise<DashboardSummary> {
        return await dashboardRepository.getDashboardSummary(page, pageSize, orgId, type, search);
    }
}

export const dashboardService = new DashboardService();
