import { AppDataSource } from "../../config/database.js";
import { PasswordResetToken } from "../../models/Account/password-reset-token.model.js";

export class PasswordResetTokenRepository {
    private repo = AppDataSource.getRepository(PasswordResetToken);

    async create(data: Partial<PasswordResetToken>): Promise<PasswordResetToken> {
        const entity = this.repo.create(data);
        return await this.repo.save(entity);
    }

    async findByToken(token: string): Promise<PasswordResetToken | null> {
        return await this.repo.findOne({
            where: { Token: token, IsUsed: false },
            relations: ["User"]
        });
    }

    async markAsUsed(id: number): Promise<void> {
        await this.repo.update(id, { IsUsed: true, UsedAt: new Date() });
    }

    async invalidatePreviousTokens(userId: string): Promise<void> {
        await this.repo.update(
            { UserId: userId, IsUsed: false },
            { IsUsed: true, UsedAt: new Date() }
        );
    }
}

export const passwordResetTokenRepository = new PasswordResetTokenRepository();
