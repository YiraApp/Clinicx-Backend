import type { Request, Response } from "express";
import { APILogService } from "../../services/Logs/apilog.service.js";

const apiLogService = new APILogService();

export class APILogController {
    async getAllLogs(req: Request, res: Response): Promise<void> {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const pageSize = parseInt(req.query.pageSize as string) || 10;
            const filters = {
                search: req.query.search as string,
                method: req.query.method as string,
                status: req.query.status as string
            };

            const result = await apiLogService.getAllLogs(page, pageSize, filters);
            res.status(200).json({
                status: true,
                data: result.data,
                pagination: {
                    totalRecords: result.total,
                    page,
                    pageSize,
                    totalPages: Math.ceil(result.total / pageSize)
                },
                message: "API logs retrieved successfully",
            });
        } catch (error) {
            console.error("Error fetching API logs:", error);
            res.status(500).json({
                status: false,
                message: "Failed to retrieve API logs",
                error: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }

    async getLogById(req: Request, res: Response): Promise<void> {
        try {
            const idParam = req.params.id;
            
            if (!idParam) {
                res.status(400).json({
                    status: false,
                    message: "Log ID is required",
                });
                return;
            }

            // Handle case where id might be an array
            const logId = (Array.isArray(idParam) ? idParam[0] : idParam) as string;
            const log = await apiLogService.getLogById(parseInt(logId));

            if (!log) {
                res.status(404).json({
                    status: false,
                    message: "Log not found",
                });
                return;
            }

            res.status(200).json({
                status: true,
                data: log,
                message: "API log retrieved successfully",
            });
        } catch (error) {
            console.error("Error fetching API log:", error);
            res.status(500).json({
                status: false,
                message: "Failed to retrieve API log",
                error: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }

    async getLogsByDateRange(req: Request, res: Response): Promise<void> {
        try {
            const { startDate, endDate } = req.query;
            const limit = parseInt(req.query.limit as string) || 100;

            if (!startDate || !endDate) {
                res.status(400).json({
                    success: false,
                    message: "startDate and endDate query parameters are required",
                });
                return;
            }

            const logs = await apiLogService.getLogsByDateRange(
                new Date(startDate as string),
                new Date(endDate as string),
                limit
            );

            res.status(200).json({
                status: true,
                data: logs,
                count: logs.length,
                message: "API logs retrieved successfully",
            });
        } catch (error) {
            console.error("Error fetching API logs by date range:", error);
            res.status(500).json({
                status: false,
                message: "Failed to retrieve API logs",
                error: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }

    async getLogsByMethod(req: Request, res: Response): Promise<void> {
        try {
            const { method } = req.query;
            const limit = parseInt(req.query.limit as string) || 50;

            if (!method) {
                res.status(400).json({
                    success: false,
                    message: "method query parameter is required",
                });
                return;
            }

            const logs = await apiLogService.getLogsByMethod(method as string, limit);

            res.status(200).json({
                status: true,
                data: logs,
                count: logs.length,
                message: "API logs retrieved successfully",
            });
        } catch (error) {
            console.error("Error fetching API logs by method:", error);
            res.status(500).json({
                status: false,
                message: "Failed to retrieve API logs",
                error: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }

    async getLogsByPath(req: Request, res: Response): Promise<void> {
        try {
            const { path } = req.query;
            const limit = parseInt(req.query.limit as string) || 50;

            if (!path) {
                res.status(400).json({
                    success: false,
                    message: "path query parameter is required",
                });
                return;
            }

            const logs = await apiLogService.getLogsByPath(path as string, limit);

            res.status(200).json({
                status: true,
                data: logs,
                count: logs.length,
                message: "API logs retrieved successfully",
            });
        } catch (error) {
            console.error("Error fetching API logs by path:", error);
            res.status(500).json({
                status: false,
                message: "Failed to retrieve API logs",
                error: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }

    async getSlowQueries(req: Request, res: Response): Promise<void> {
        try {
            const responseTimeMs = parseInt(req.query.responseTimeMs as string) || 1000;
            const limit = parseInt(req.query.limit as string) || 50;

            const logs = await apiLogService.getSlowQueries(responseTimeMs, limit);

            res.status(200).json({
                status: true,
                data: logs,
                count: logs.length,
                message: "Slow queries retrieved successfully",
            });
        } catch (error) {
            console.error("Error fetching slow queries:", error);
            res.status(500).json({
                status: false,
                message: "Failed to retrieve slow queries",
                error: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }

    async getDatabaseStats(req: Request, res: Response): Promise<void> {
        try {
            const stats = await apiLogService.getDatabaseStats();

            res.status(200).json({
                status: true,
                data: stats,
                message: "Database statistics retrieved successfully",
            });
        } catch (error) {
            console.error("Error fetching database stats:", error);
            res.status(500).json({
                status: false,
                message: "Failed to retrieve database statistics",
                error: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }

    async getTableStats(req: Request, res: Response): Promise<void> {
        try {
            const tableStats = await apiLogService.getTableStats();

            res.status(200).json({
                status: true,
                data: tableStats,
                count: tableStats.length,
                message: "Table statistics retrieved successfully",
            });
        } catch (error) {
            console.error("Error fetching table stats:", error);
            res.status(500).json({
                status: false,
                message: "Failed to retrieve table statistics",
                error: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }

    async getFullDatabaseReport(req: Request, res: Response): Promise<void> {
        try {
            const report = await apiLogService.getFullDatabaseReport();

            res.status(200).json({
                status: true,
                data: report,
                message: "Full database report retrieved successfully",
            });
        } catch (error) {
            console.error("Error fetching database report:", error);
            res.status(500).json({
                status: false,
                message: "Failed to retrieve database report",
                error: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
}

export const apiLogController = new APILogController();
