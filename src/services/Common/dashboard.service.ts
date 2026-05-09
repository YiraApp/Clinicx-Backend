import os from "os";
import si from "systeminformation";
import { dashboardRepository } from "../../repositories/Common/dashboard.repository.js";
import type { DashboardSummary, IDashboardService } from "../../interfaces/Service/Common/IDashboardService.js";

export class DashboardService implements IDashboardService {
    async getAdminDashboardData(orgId?: number, hospId?: number) {
        return await dashboardRepository.getAdminDashboardStats(orgId, hospId);
    }

    async getDashboardSummary(page?: number, pageSize?: number, orgId?: number, type?: string, search?: string): Promise<DashboardSummary> {
        return await dashboardRepository.getDashboardSummary(page, pageSize, orgId, type, search);
    }

    async getAnalyticsData() {
        const dbStats = await dashboardRepository.getAnalyticsStats();

        // =========================
        // SYSTEM METRICS (REAL)
        // =========================

        const cpu = await si.currentLoad();
        const mem = await si.mem();
        const disk = await si.fsSize();
        const net = await si.networkStats();
        const time = await si.time();

        const memoryUsage = Math.round((mem.used / mem.total) * 100);
        const cpuUsage = Math.round(cpu.currentLoad);
        const diskUsage = Math.round(disk[0]?.use || 0);

        const networkUsage =
            Math.round((net[0]?.rx_sec || 0) + (net[0]?.tx_sec || 0));

        return {
            ...dbStats,
            systemPerformance: {
                uptime: this.formatUptime(time.uptime),
                uptimeRaw: time.uptime, // real seconds uptime

                cpuUsage: cpuUsage > 100 ? 100 : cpuUsage,
                memoryUsage,
                diskUsage,
                networkUsage
            }
        };
    }
    
    async getFrontdeskDashboardData(hospId: number) {
        const rawData = await dashboardRepository.getFrontdeskDashboardStats(hospId);
        const { stats, recentActivity } = rawData;

        // Calculate trends
        const calcTrend = (today: number, yesterday: number) => {
            const diff = today - yesterday;
            return diff >= 0 ? `+${diff}` : `${diff}`;
        };

        const processedStats = [
            { 
                title: "Today's Check-ins", 
                value: stats.todayCheckIns, 
                change: calcTrend(stats.todayCheckIns, stats.yesterdayCheckIns), 
                trend: stats.todayCheckIns >= stats.yesterdayCheckIns ? "up" : "down"
            },
            { 
                title: "Appointments Scheduled", 
                value: stats.appointmentsScheduled, 
                change: calcTrend(stats.appointmentsScheduled, stats.yesterdayScheduled), 
                trend: stats.appointmentsScheduled >= stats.yesterdayScheduled ? "up" : "down"
            },
            { 
                title: "Waiting Patients", 
                value: stats.waitingPatients, 
                change: calcTrend(stats.waitingPatients, stats.yesterdayWaiting), 
                trend: stats.waitingPatients >= stats.yesterdayWaiting ? "up" : "down"
            },
            { 
                title: "Payments Collected", 
                value: `Rs ${stats.paymentsCollected.toLocaleString()}`, 
                change: `Rs ${Math.abs(stats.paymentsCollected - stats.yesterdayPayments).toLocaleString()}`, 
                trend: stats.paymentsCollected >= stats.yesterdayPayments ? "up" : "down"
            }
        ];

        return {
            stats: processedStats,
            recentActivity
        };
    }

    async getDoctorDashboardData(doctorId: string, hospId: number) {
        return await dashboardRepository.getDoctorDashboardStats(doctorId, hospId);
    }

    private formatUptime(seconds: number): string {
        const days = Math.floor(seconds / (3600 * 24));
        const hours = Math.floor((seconds % (3600 * 24)) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        return `${days}d ${hours}h ${minutes}m`;
    }
}

export const dashboardService = new DashboardService();
