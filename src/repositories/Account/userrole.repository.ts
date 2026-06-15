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

    async findAllByUserId(userId: string): Promise<UserRole[]> {
        return await this.repo.find({
            where: { UserId: userId, IsDeleted: false },
            relations: ["Role", "Organization", "Hospital"]
        });
    }

    async findByUserIdAndRoleId(userId: string, roleId: string): Promise<UserRole | null> {
        return await this.repo.findOne({
            where: { UserId: userId, RoleId: roleId, Status: true, IsDeleted: false },
            relations: ["Role"]
        });
    }

    async save(userRole: UserRole): Promise<UserRole> {
        return await this.repo.save(userRole);
    }

    async saveAll(userRoles: UserRole[]): Promise<UserRole[]> {
        return await this.repo.save(userRoles);
    }
}

export const userRoleRepository = new UserRoleRepository();
