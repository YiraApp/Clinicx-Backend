import type { RoleResponse } from "../../../dtos/Response/Account/RoleResponse.js";

/**
 * Interface for Role Service operations.
 * Defines the contract for Role-related business logic.
 */
export interface IRoleService {
    /**
     * Retrieves all active roles and maps them to a simplified response DTO.
     */
    getActiveRoles(): Promise<RoleResponse[]>;
}
