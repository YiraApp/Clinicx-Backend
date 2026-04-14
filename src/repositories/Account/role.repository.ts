import { AppDataSource } from "../../config/database.js";
import { Role } from "../../models/Account/role.model.js";
import type { IRoleRepository } from "../../interfaces/Repository/Account/IRoleRepository.js";

/**
 * Repository for Role operations.
 */
export class RoleRepository implements IRoleRepository {
    private db = AppDataSource.getRepository(Role);

    async getAllRoles(): Promise<Role[]> {
        const roles = await this.db.find({
            where: { Status: true },
            select: ["Id", "RoleName", "NormalizedName"]
        });

        return roles;
    }
}

export const roleRepository = new RoleRepository();
