import { AppDataSource } from "../../config/database.js";

export class DatabaseStatsService {
    async getDatabaseStats(): Promise<any> {
        try {
            // Get database size and space
            const dbSizeQuery = `
                SELECT 
                    SUM(size * 8 / 1024.0) AS DatabaseSizeMB,
                    SUM(CASE WHEN max_size = -1 THEN 0 ELSE max_size * 8 / 1024.0 END) AS MaxSizeMB
                FROM sys.database_files;
            `;

            // Get total records count across all user tables
            const totalRecordsQuery = `
                SELECT SUM(p.rows) AS TotalRows
                FROM sys.tables AS t
                INNER JOIN sys.partitions AS p ON t.object_id = p.object_id
                WHERE t.is_ms_shipped = 0 AND p.index_id IN (0, 1);
            `;

            // Get session/connection stats
            const connectionsQuery = `
                SELECT 
                    COUNT(*) as TotalSessions,
                    SUM(CASE WHEN statusValue = 'running' THEN 1 ELSE 0 END) as ActiveSessions,
                    SUM(CASE WHEN statusValue = 'sleeping' THEN 1 ELSE 0 END) as IdleSessions
                FROM (
                    SELECT status as statusValue FROM sys.dm_exec_sessions WHERE is_user_process = 1
                ) as SessionTable
            `;

            const [dbSize, totalRecords, connections] = await Promise.all([
                AppDataSource.query(dbSizeQuery),
                AppDataSource.query(totalRecordsQuery),
                AppDataSource.query(connectionsQuery)
            ]);

            return {
                DatabaseSizeMB: Math.round(dbSize[0]?.DatabaseSizeMB || 0),
                UsedSpaceMB: Math.round(dbSize[0]?.DatabaseSizeMB * 0.8), // Approximation
                FreeSpaceMB: Math.round(dbSize[0]?.DatabaseSizeMB * 0.2), // Approximation
                TotalRecords: Number(totalRecords[0]?.TotalRows || 0),
                TotalTables: await this.getTableCount(),
                ActiveConnections: Number(connections[0]?.ActiveSessions || 0),
                IdleSessions: Number(connections[0]?.IdleSessions || 0),
                QueriesPerSecond: Math.floor(Math.random() * 10) + 1, // Simulated metric
            };
        } catch (error) {
            console.error("Error fetching database stats:", error);
            throw error;
        }
    }

    private async getTableCount(): Promise<number> {
        const query = "SELECT COUNT(*) as count FROM sys.tables WHERE is_ms_shipped = 0";
        const result = await AppDataSource.query(query);
        return result[0]?.count || 0;
    }

    async getTableStats(): Promise<any[]> {
        const query = `
            SELECT 
                t.name AS TableName,
                p.rows AS Records,
                CAST(ROUND((SUM(a.total_pages) * 8) / 1024.0, 2) AS NUMERIC(36, 2)) AS SizeMB,
                so.create_date AS TableCreatedAt
            FROM sys.tables t
            INNER JOIN sys.objects so ON t.object_id = so.object_id
            INNER JOIN sys.indexes i ON t.object_id = i.object_id
            INNER JOIN sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
            INNER JOIN sys.allocation_units a ON p.partition_id = a.container_id
            WHERE t.is_ms_shipped = 0 AND i.type <= 1
            GROUP BY t.name, p.rows, so.create_date
            ORDER BY SizeMB DESC
        `;
        return await AppDataSource.query(query);
    }

    async getFullDatabaseReport(): Promise<any> {
        const [stats, tables] = await Promise.all([
            this.getDatabaseStats(),
            this.getTableStats()
        ]);

        return {
            overview: stats,
            tables: tables,
            generatedAt: new Date()
        };
    }
}
