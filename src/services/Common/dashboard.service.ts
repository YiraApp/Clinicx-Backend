import { dashboardRepository } from "../../repositories/Common/dashboard.repository.js";
import type { DashboardSummary, IDashboardService } from "../../interfaces/Service/Common/IDashboardService.js";

export class DashboardService implements IDashboardService {
    async getAdminDashboardData() {
        return await dashboardRepository.getAdminDashboardStats();
    }

    async getDashboardSummary(page?: number, pageSize?: number, orgId?: number, type?: string, search?: string): Promise<DashboardSummary> {
        return await dashboardRepository.getDashboardSummary(page, pageSize, orgId, type, search);
    }
}

export const dashboardService = new DashboardService();
