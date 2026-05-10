import { AppDataSource } from "../../config/database.js";
import { AppointmentShareLink } from "../../models/Appointments/appointment-share-link.model.js";

export class AppointmentShareLinkRepository {
    private repo = AppDataSource.getRepository(AppointmentShareLink);

    async create(data: Partial<AppointmentShareLink>): Promise<AppointmentShareLink> {
        const link = this.repo.create(data);
        return await this.repo.save(link);
    }

    async findByToken(token: string): Promise<AppointmentShareLink | null> {
        return await this.repo.findOne({
            where: { ShareToken: token, IsActive: true, IsDeleted: false }
        });
    }

    async update(id: number, data: Partial<AppointmentShareLink>): Promise<void> {
        await this.repo.update(id, { ...data, UpdatedAt: new Date() });
    }
}

export const appointmentShareLinkRepository = new AppointmentShareLinkRepository();
