import { AppDataSource } from "../../config/database.js";
import { UserRole } from "../../models/Account/userrole.model.js";
import type { IUserRoleRepository } from "../../interfaces/Repository/Account/IUserRoleRepository.js";

/**
 * Repository implementation for UserRole entity.
 */
export class UserRoleRepository implements IUserRoleRepository {
    private repo = AppDataSource.getRepository(UserRole);

    async findByUserId(userId: string): Promise<UserRole[]> {
        return await this.repo.find({
            where: { UserId: userId, Status: true, IsDeleted: false },
            relations: ["Role", "Organization", "Hospital"]
        });
    }
}

export const userRoleRepository = new UserRoleRepository();
