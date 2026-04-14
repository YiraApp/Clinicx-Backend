import { AppDataSource } from "../../config/database.js";
import { Role } from "../../models/Account/role.model.js";
import { redisService } from "../../services/Common/redis.service.js";
import { CacheKeys } from "../../utils/cache.keys.js";
import type { IRoleRepository } from "../../interfaces/Repository/Account/IRoleRepository.js";

/**
 * Repository for Role operations.
 */
export class RoleRepository implements IRoleRepository {
    private db = AppDataSource.getRepository(Role);

    async getAllRoles(): Promise<Role[]> {
        const cachedRoles = await redisService.get<Role[]>(CacheKeys.ROLES_LIST);
        if (cachedRoles) return cachedRoles;

        const roles = await this.db.find({
            where: { Status: true },
            select: ["Id", "RoleName", "NormalizedName"]
        });

        await redisService.set(CacheKeys.ROLES_LIST, roles);
        return roles;
    }
}

export const roleRepository = new RoleRepository();
