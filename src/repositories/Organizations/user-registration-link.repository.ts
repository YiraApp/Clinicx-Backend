import { AppDataSource } from "../../config/database";
import { UserRegistrationLink } from "../../models/Organizations/user-registration-link.model";

export class UserRegistrationLinkRepository {
    private repo = AppDataSource.getRepository(UserRegistrationLink);

    async save(link: UserRegistrationLink): Promise<UserRegistrationLink> {
        return await this.repo.save(link);
    }

    async findByToken(token: string): Promise<UserRegistrationLink | null> {
        return await this.repo.findOne({ where: { Token: token, IsUsed: false } });
    }

    async findByEmail(email: string): Promise<UserRegistrationLink | null> {
        return await this.repo.findOne({ where: { Email: email, IsUsed: false } });
    }

    async markAsUsed(tokenId: number): Promise<void> {
        await this.repo.update(tokenId, { IsUsed: true });
    }
}

export const userRegistrationLinkRepository = new UserRegistrationLinkRepository();
