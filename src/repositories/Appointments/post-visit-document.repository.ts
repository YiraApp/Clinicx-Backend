import { AppDataSource } from "../../config/database.js";
import { PostVisitDocument } from "../../models/Appointments/post-visit-document.model.js";

export class PostVisitDocumentRepository {
    private repo = AppDataSource.getRepository(PostVisitDocument);

    async create(data: Partial<PostVisitDocument>): Promise<PostVisitDocument> {
        const doc = this.repo.create(data);
        return await this.repo.save(doc);
    }

    async findByAppointment(appointmentId: number): Promise<PostVisitDocument[]> {
        return await this.repo.find({
            where: { AppointmentId: appointmentId, IsDeleted: false },
            order: { CreatedAt: "DESC" }
        });
    }

    async findOne(criteria: any): Promise<PostVisitDocument | null> {
        return await this.repo.findOne({ where: criteria });
    }

    async findById(id: number): Promise<PostVisitDocument | null> {
        return await this.repo.findOne({ where: { Id: id } as any });
    }

    async update(id: number, data: Partial<PostVisitDocument>): Promise<void> {
        await this.repo.update(id, { ...data, UpdatedAt: new Date() });
    }
}

export const postVisitDocumentRepository = new PostVisitDocumentRepository();
