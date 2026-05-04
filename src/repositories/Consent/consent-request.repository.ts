import { AppDataSource } from "../../config/database.js";
import { ConsentRequest } from "../../models/Consent/consent-request.model.js";

export class ConsentRequestRepository {
    private repo = AppDataSource.getRepository(ConsentRequest);

    async create(data: Partial<ConsentRequest>): Promise<ConsentRequest> {
        const request = this.repo.create(data);
        return await this.repo.save(request);
    }

    async findByLink(link: string): Promise<ConsentRequest | null> {
        return await this.repo.findOne({
            where: { RequestLink: link },
            relations: ["Patient", "Template", "Hospital"]
        });
    }

    async updateStatus(id: number, status: string): Promise<void> {
        await this.repo.update(id, { 
            Status: status, 
            SignedAt: status === "Signed" ? new Date() : undefined,
            UpdatedAt: new Date() 
        });
    }
}

export const consentRequestRepository = new ConsentRequestRepository();
