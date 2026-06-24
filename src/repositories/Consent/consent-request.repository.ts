import { AppDataSource } from "../../config/database.js";
import { ConsentRequest } from "../../models/Consent/consent-request.model.js";

export class ConsentRequestRepository {
    private repo = AppDataSource.getRepository(ConsentRequest);

    async create(data: Partial<ConsentRequest>): Promise<ConsentRequest> {
        const request = this.repo.create(data);
        return await this.repo.save(request);
    }

    async findOne(options: any): Promise<ConsentRequest | null> {
        return await this.repo.findOne(options);
    }

    async save(request: ConsentRequest): Promise<ConsentRequest> {
        return await this.repo.save(request);
    }

    async findByLink(link: string): Promise<ConsentRequest | null> {
        return await this.repo.findOne({
            where: { RequestLink: link },
            relations: ["Patient", "Template", "Hospital", "Template.TemplateFields"]
        });
    }

    async findManyByLink(link: string): Promise<ConsentRequest[]> {
        return await this.repo.find({
            where: { RequestLink: link },
            relations: ["Patient", "Template", "Hospital", "Template.TemplateFields"]
        });
    }

    async updateStatus(id: number, status: string): Promise<void> {
        await this.repo.update(id, { 
            Status: status, 
            SignedAt: status === "Signed" ? new Date() : undefined,
            UpdatedAt: new Date() 
        });
    }

    async findByAppointmentId(appointmentId: number): Promise<ConsentRequest[]> {
        return await this.repo.find({
            where: { AppointmentId: appointmentId },
            relations: ["Patient", "Template", "Hospital"]
        });
    }

    async findByAppointmentIds(appointmentIds: number[]): Promise<ConsentRequest[]> {
        if (appointmentIds.length === 0) return [];
        return await this.repo.createQueryBuilder("r")
            .where("r.AppointmentId IN (:...ids)", { ids: appointmentIds })
            .getMany();
    }
}

export const consentRequestRepository = new ConsentRequestRepository();
