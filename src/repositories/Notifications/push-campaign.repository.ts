import { AppDataSource } from "../../config/database.js";
import { PushCampaign } from "../../models/Notifications/push-campaign.model.js";

export class PushCampaignRepository {
    private repo = AppDataSource.getRepository(PushCampaign);

    async findAll(filter?: {
        scheduleType?: string;
        isActive?: boolean;
        category?: string;
        status?: string;
    }): Promise<PushCampaign[]> {
        const qb = this.repo.createQueryBuilder("c");

        if (filter?.scheduleType) {
            qb.andWhere("c.ScheduleType = :scheduleType", { scheduleType: filter.scheduleType.toLowerCase() });
        }

        if (filter?.isActive !== undefined) {
            qb.andWhere("c.IsActive = :isActive", { isActive: filter.isActive });
        }

        if (filter?.category) {
            qb.andWhere("c.NotificationCategory = :category", { category: filter.category.toUpperCase() });
        }

        if (filter?.status) {
            qb.andWhere("c.Status = :status", { status: filter.status.toUpperCase() });
        }

        qb.orderBy("c.CreatedAt", "DESC");
        return qb.getMany();
    }

    async findById(id: number): Promise<PushCampaign | null> {
        return this.repo.findOne({ where: { Id: id } });
    }

    async create(campaign: Partial<PushCampaign>): Promise<PushCampaign> {
        const item = this.repo.create(campaign);
        return this.repo.save(item);
    }

    async update(id: number, campaign: Partial<PushCampaign>): Promise<PushCampaign | null> {
        await this.repo.update(id, {
            ...campaign,
            UpdatedAt: new Date(),
        });
        return this.findById(id);
    }

    async delete(id: number): Promise<boolean> {
        const res = await this.repo.delete(id);
        return (res.affected ?? 0) > 0;
    }

    async getActiveScheduledAndRecurring(): Promise<PushCampaign[]> {
        return this.repo.createQueryBuilder("c")
            .where("c.IsActive = 1")
            .andWhere("c.Status IN ('ACTIVE', 'SCHEDULED', 'RECURRING')")
            .andWhere("c.ScheduleType IN ('scheduled', 'recurring')")
            .getMany();
    }
}

export const pushCampaignRepository = new PushCampaignRepository();
