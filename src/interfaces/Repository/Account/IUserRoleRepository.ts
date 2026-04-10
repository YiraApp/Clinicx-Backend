import { UserRole } from "../../../models/Account/userrole.model.js";

/**
 * Interface for UserRole Repository.
 */
export interface IUserRoleRepository {
    findByUserId(userId: string): Promise<UserRole[]>;
}
