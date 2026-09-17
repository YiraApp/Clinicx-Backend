import { AppDataSource } from "../../config/database.js";
import { Feedback } from "../../models/Feedback/feedback.model.js";

export class FeedbackRepository {
    private get repo() {
        return AppDataSource.getRepository(Feedback);
    }

    async create(data: Partial<Feedback>): Promise<Feedback> {
        const feedback = this.repo.create(data);
        return await this.repo.save(feedback);
    }

    async findById(id: number): Promise<Feedback | null> {
        return await this.repo.findOne({ where: { Id: id } });
    }

    async findWithFilters(filters: {
        orgId?: number;
        hospitalId?: number;
        userId?: string;
        rating?: number;
        category?: string;
        status?: string;
        search?: string;
        page?: number;
        pageSize?: number;
    }): Promise<{ data: Feedback[]; total: number; page: number; pageSize: number }> {
        const page = Math.max(1, Number(filters.page) || 1);
        const pageSize = Math.max(1, Math.min(100, Number(filters.pageSize) || 20));
        const skip = (page - 1) * pageSize;

        const query = this.repo.createQueryBuilder("f");

        if (filters.orgId) {
            query.andWhere("f.OrganizationId = :orgId", { orgId: filters.orgId });
        }

        if (filters.hospitalId) {
            query.andWhere("f.HospitalId = :hospitalId", { hospitalId: filters.hospitalId });
        }

        if (filters.userId) {
            query.andWhere("f.UserId = :userId", { userId: filters.userId });
        }

        if (filters.rating) {
            query.andWhere("f.Rating = :rating", { rating: filters.rating });
        }

        if (filters.category) {
            query.andWhere("f.Category = :category", { category: filters.category });
        }

        if (filters.status) {
            query.andWhere("f.Status = :status", { status: filters.status });
        }

        if (filters.search) {
            query.andWhere("(f.Name LIKE :search OR f.Phone LIKE :search OR f.Email LIKE :search OR f.Message LIKE :search)", {
                search: `%${filters.search.trim()}%`
            });
        }

        query.orderBy("f.CreatedAt", "DESC");
        query.skip(skip).take(pageSize);

        const [data, total] = await query.getManyAndCount();

        return {
            data,
            total,
            page,
            pageSize
        };
    }

    async getStats(orgId?: number, hospitalId?: number): Promise<{
        totalCount: number;
        averageRating: number;
        ratingBreakdown: Record<number, number>;
        categoryBreakdown: Record<string, number>;
    }> {
        const query = this.repo.createQueryBuilder("f");

        if (orgId) {
            query.andWhere("f.OrganizationId = :orgId", { orgId });
        }
        if (hospitalId) {
            query.andWhere("f.HospitalId = :hospitalId", { hospitalId });
        }

        const feedbacks = await query.select([
            "f.Rating",
            "f.Category"
        ]).getMany();

        const totalCount = feedbacks.length;
        if (totalCount === 0) {
            return {
                totalCount: 0,
                averageRating: 0,
                ratingBreakdown: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
                categoryBreakdown: {}
            };
        }

        let sumRating = 0;
        const ratingBreakdown: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        const categoryBreakdown: Record<string, number> = {};

        for (const item of feedbacks) {
            sumRating += item.Rating || 0;
            const r = item.Rating || 5;
            ratingBreakdown[r] = (ratingBreakdown[r] || 0) + 1;

            if (item.Category) {
                categoryBreakdown[item.Category] = (categoryBreakdown[item.Category] || 0) + 1;
            }
        }

        const averageRating = Number((sumRating / totalCount).toFixed(1));

        return {
            totalCount,
            averageRating,
            ratingBreakdown,
            categoryBreakdown
        };
    }

    async updateStatus(id: number, status: string, adminNotes?: string): Promise<Feedback | null> {
        const item = await this.findById(id);
        if (!item) return null;
        item.Status = status;
        if (adminNotes !== undefined) {
            item.AdminNotes = adminNotes;
        }
        item.UpdatedAt = new Date();
        return await this.repo.save(item);
    }
}

export const feedbackRepository = new FeedbackRepository();
