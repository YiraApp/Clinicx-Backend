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

    async getAnalyticsData(timeRange?: string) {
        const dbStats = await dashboardRepository.getAnalyticsStats(timeRange);

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
        const { stats, recentActivity, recentPatients } = rawData;

        // Calculate trends
        const calcTrend = (today: number, yesterday: number) => {
            const diff = today - yesterday;
            return diff >= 0 ? `+${diff}` : `${diff}`;
        };

        // `key`, `today`, `yesterday` and `format` let the page word the comparison itself;
        // `value`, `change` and `trend` stay for older clients.
        const processedStats = [
            {
                key: "checkIns",
                title: "Today's Check-ins",
                value: stats.todayCheckIns,
                today: Number(stats.todayCheckIns),
                yesterday: Number(stats.yesterdayCheckIns),
                format: "count",
                change: calcTrend(stats.todayCheckIns, stats.yesterdayCheckIns),
                trend: stats.todayCheckIns >= stats.yesterdayCheckIns ? "up" : "down"
            },
            {
                key: "scheduled",
                title: "Appointments Scheduled",
                value: stats.appointmentsScheduled,
                today: Number(stats.appointmentsScheduled),
                yesterday: Number(stats.yesterdayScheduled),
                format: "count",
                change: calcTrend(stats.appointmentsScheduled, stats.yesterdayScheduled),
                trend: stats.appointmentsScheduled >= stats.yesterdayScheduled ? "up" : "down"
            },
            {
                // A live number: who is in the queue now. There is no meaningful "yesterday".
                key: "waiting",
                title: "Waiting Patients",
                value: stats.waitingPatients,
                today: Number(stats.waitingPatients),
                yesterday: null,
                format: "count",
                change: "",
                trend: "neutral"
            },
            {
                key: "payments",
                title: "Payments Collected",
                value: `Rs ${Number(stats.paymentsCollected).toLocaleString("en-IN")}`,
                today: Number(stats.paymentsCollected),
                yesterday: Number(stats.yesterdayPayments),
                format: "money",
                change: `Rs ${Math.abs(stats.paymentsCollected - stats.yesterdayPayments).toLocaleString("en-IN")}`,
                trend: stats.paymentsCollected >= stats.yesterdayPayments ? "up" : "down"
            }
        ];

        return {
            stats: processedStats,
            recentActivity,
            recentPatients
        };
    }

    async getDoctorDashboardData(doctorId: string, hospId: number, orgId?: number) {
        return await dashboardRepository.getDoctorDashboardStats(doctorId, hospId, orgId);
    }

    private formatUptime(seconds: number): string {
        const days = Math.floor(seconds / (3600 * 24));
        const hours = Math.floor((seconds % (3600 * 24)) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        return `${days}d ${hours}h ${minutes}m`;
    }
}

export const dashboardService = new DashboardService();
