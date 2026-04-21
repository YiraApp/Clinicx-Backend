import { Repository } from "typeorm";
import { AppDataSource } from "../../config/database.js";
import { APILog } from "../../models/Logs/apilog.model.js";

export class APILogRepository {
    private repository: Repository<APILog>;

    constructor() {
        this.repository = AppDataSource.getRepository(APILog);
    }

    async getAllLogs(page: number = 1, pageSize: number = 10, filters?: any): Promise<{ data: APILog[], total: number }> {
        const skip = (page - 1) * pageSize;
        const query = this.repository.createQueryBuilder("log");

        if (filters?.method && filters.method !== 'all') {
            query.andWhere("log.Method = :method", { method: filters.method });
        }

        if (filters?.status && filters.status !== 'all') {
            if (filters.status === 'success') {
                query.andWhere("log.ResponseStatusCode < 400 AND log.ResponseTimeMs < 1000");
            } else if (filters.status === 'error') {
                query.andWhere("log.ResponseStatusCode >= 400");
            } else if (filters.status === 'slow') {
                query.andWhere("log.ResponseTimeMs >= 1000");
            }
        }

        if (filters?.search) {
            query.andWhere("(log.Path LIKE :search OR log.RequestBody LIKE :search OR log.QueryString LIKE :search)", { search: `%${filters.search}%` });
        }

        const [data, total] = await query
            .select([
                "log.LogId",
                "log.Method",
                "log.Path",
                "log.QueryString",
                "log.RequestBody",
                "log.Response",
                "log.ResponseStatusCode",
                "log.ResponseTimeMs",
                "log.RequestedOn",
                "log.RequestHeaders"
            ])
            .orderBy("log.LogId", "DESC")
            .skip(skip)
            .take(pageSize)
            .getManyAndCount();

        return { data, total };
    }

    async getLogById(id: number): Promise<APILog | null> {
        return await this.repository.findOne({
            where: { LogId: id },
        });
    }

    async getLogsByDateRange(startDate: Date, endDate: Date, limit: number = 100): Promise<APILog[]> {
        return await this.repository
            .createQueryBuilder("log")
            .where("log.RequestedOn >= :startDate", { startDate })
            .andWhere("log.RequestedOn <= :endDate", { endDate })
            .orderBy("log.LogId", "DESC")
            .take(limit)
            .getMany();
    }

    async getLogsByMethod(method: string, limit: number = 50): Promise<APILog[]> {
        return await this.repository
            .createQueryBuilder("log")
            .where("log.Method = :method", { method })
            .orderBy("log.LogId", "DESC")
            .take(limit)
            .getMany();
    }

    async getLogsByPath(path: string, limit: number = 50): Promise<APILog[]> {
        return await this.repository
            .createQueryBuilder("log")
            .where("log.Path LIKE :path", { path: `%${path}%` })
            .orderBy("log.LogId", "DESC")
            .take(limit)
            .getMany();
    }

    async getLogsByStatusCode(statusCode: number, limit: number = 50): Promise<APILog[]> {
        return await this.repository
            .createQueryBuilder("log")
            .where("log.ResponseStatusCode = :statusCode", { statusCode })
            .orderBy("log.LogId", "DESC")
            .take(limit)
            .getMany();
    }

    async getSlowQueries(responseTimeMs: number = 1000, limit: number = 50): Promise<APILog[]> {
        return await this.repository
            .createQueryBuilder("log")
            .where("log.ResponseTimeMs >= :responseTimeMs", { responseTimeMs })
            .orderBy("log.ResponseTimeMs", "DESC")
            .take(limit)
            .getMany();
    }

    async getTotalLogCount(): Promise<number> {
        return await this.repository.count();
    }

    async getAverageResponseTime(): Promise<number> {
        const result = await this.repository
            .createQueryBuilder("log")
            .select("AVG(log.ResponseTimeMs)", "avg")
            .getRawOne();
        return result?.avg || 0;
    }
}
