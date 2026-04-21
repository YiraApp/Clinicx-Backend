import { APILogRepository } from "../../repositories/Logs/apilog.repository.js";
import { APILog } from "../../models/Logs/apilog.model.js";
import { DatabaseStatsService } from "../Common/database-stats.service.js";
import { AppDataSource } from "../../config/database.js";

export class APILogService {
    private apiLogRepository: APILogRepository;
    private databaseStatsService: DatabaseStatsService;

    constructor() {
        this.apiLogRepository = new APILogRepository();
        this.databaseStatsService = new DatabaseStatsService();
    }

    async getAllLogs(page: number = 1, pageSize: number = 10, filters?: any): Promise<{ data: APILog[], total: number }> {
        return await this.apiLogRepository.getAllLogs(page, pageSize, filters);
    }

    async getLogById(id: number): Promise<APILog | null> {
        return await this.apiLogRepository.getLogById(id);
    }

    async getLogsByDateRange(startDate: Date, endDate: Date, limit: number = 100): Promise<APILog[]> {
        return await this.apiLogRepository.getLogsByDateRange(startDate, endDate, limit);
    }

    async getLogsByMethod(method: string, limit: number = 50): Promise<APILog[]> {
        return await this.apiLogRepository.getLogsByMethod(method, limit);
    }

    async getLogsByPath(path: string, limit: number = 50): Promise<APILog[]> {
        return await this.apiLogRepository.getLogsByPath(path, limit);
    }

    async getLogsByStatusCode(statusCode: number, limit: number = 50): Promise<APILog[]> {
        return await this.apiLogRepository.getLogsByStatusCode(statusCode, limit);
    }

    async getSlowQueries(responseTimeMs: number = 1000, limit: number = 50): Promise<APILog[]> {
        return await this.apiLogRepository.getSlowQueries(responseTimeMs, limit);
    }

    async getTotalLogCount(): Promise<number> {
        return await this.apiLogRepository.getTotalLogCount();
    }

    async getAverageResponseTime(): Promise<number> {
        return await this.apiLogRepository.getAverageResponseTime();
    }

    async getDatabaseStats(): Promise<any> {
        // Run optimized aggregation in one single query to save time
        const logMetricsQuery = `
            SELECT 
                COUNT(*) as totalLogs,
                ISNULL(AVG(CAST(ResponseTimeMs AS FLOAT)), 0) as avgTime,
                SUM(CASE WHEN ResponseTimeMs >= 1000 THEN 1 ELSE 0 END) as slowCount
            FROM APILogs
            WHERE RequestedOn >= DATEADD(DAY, -7, GETUTCDATE()) -- Limit to last 7 days for performance
        `;
        
        const [logMetrics, dbStats] = await Promise.all([
            AppDataSource.query(logMetricsQuery),
            this.databaseStatsService.getDatabaseStats()
        ]);

        const metrics = logMetrics[0] || { totalLogs: 0, avgTime: 0, slowCount: 0 };

        return {
            totalLogs: Number(metrics.totalLogs),
            avgResponseTime: Math.round(Number(metrics.avgTime)),
            slowQueriesCount: Number(metrics.slowCount),
            databaseSizeMB: dbStats.DatabaseSizeMB,
            usedSpaceMB: dbStats.UsedSpaceMB,
            freeSpaceMB: dbStats.FreeSpaceMB,
            totalRecords: dbStats.TotalRecords,
            totalTables: dbStats.TotalTables,
            activeConnections: dbStats.ActiveConnections,
            idleConnections: dbStats.IdleSessions,
            queriesPerSecond: dbStats.QueriesPerSecond,
            avgResponseTimeMs: Math.round(Number(metrics.avgTime)), // Map to the same value
        };
    }

    async getFullDatabaseReport(): Promise<any> {
        return await this.databaseStatsService.getFullDatabaseReport();
    }

    async getTableStats(): Promise<any> {
        return await this.databaseStatsService.getTableStats();
    }
}
