import type { Role } from "../../../models/Account/role.model.js";

/**
 * Interface for Role Repository operations.
 * Defines the contract for fetching role data from the persistence layer.
 */
export interface IRoleRepository {
    /**
     * Gets all roles with Status: true.
     */
    getAllRoles(): Promise<Role[]>;
}
