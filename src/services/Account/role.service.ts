import { roleRepository } from "../../repositories/Account/role.repository.js";
import type { RoleResponse } from "../../dtos/Response/Account/RoleResponse.js";
import type { IRoleService } from "../../interfaces/Service/Account/IRoleService.js";

/**
 * Service for Role-related business logic.
 */
export class RoleService implements IRoleService {
    async getActiveRoles(): Promise<RoleResponse[]> {
        const roles = await roleRepository.getAllRoles();

        // Map models to DTOs
        return roles.map(role => ({
            Id: role.Id,
            RoleName: role.RoleName,
            NormalizedName: role.NormalizedName
        }));
    }
}

export const roleService = new RoleService();
