import { AppDataSource } from "../../config/database.js";
import { MeetingRedirection } from "../../models/Appointments/meeting-redirection.model.js";

export class MeetingRedirectionRepository {
    private repo = AppDataSource.getRepository(MeetingRedirection);

    async create(data: Partial<MeetingRedirection>): Promise<MeetingRedirection> {
        const redirection = this.repo.create(data);
        return await this.repo.save(redirection);
    }

    async findByUrlId(urlId: string): Promise<MeetingRedirection | null> {
        return await this.repo.findOne({
            where: { UrlId: urlId, IsActive: true }
        });
    }

    async update(id: number, data: Partial<MeetingRedirection>): Promise<void> {
        await this.repo.update(id, data);
    }

    async incrementAccessCount(id: number): Promise<void> {
        await this.repo.increment({ Id: id }, "AccessCount", 1);
        await this.repo.update(id, { LastAccessedAt: new Date() });
    }
}

export const meetingRedirectionRepository = new MeetingRedirectionRepository();
