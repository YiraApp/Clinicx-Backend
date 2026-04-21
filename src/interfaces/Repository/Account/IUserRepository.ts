import type { User } from "../../../models/Account/user.model.js";

/**
 * Interface for User Repository operations.
 */
export interface IUserRepository {
    /**
     * Finds the primary user for a given phone number.
     */
    findPrimaryByPhone(phone: string): Promise<User | null>;

    /**
     * Counts the number of users associated with a phone number.
     */
    countUsersByPhone(phone: string): Promise<number>;

    /**
     * Finds a user by ID.
     */
    findById(id: string): Promise<User | null>;

    /**
     * Finds a user by email.
     */
    findByEmail(email: string): Promise<User | null>;

    /**
     * Saves a user to the database.
     */
    save(user: User): Promise<User>;

    /**
     * Gets all users with filtering and pagination.
     */
    getUsers(page: number, pageSize: number, filters?: {
        search?: string;
        roleId?: string;
        organizationId?: number;
        status?: boolean;
        fromDate?: Date;
        toDate?: Date;
        sortBy?: 'createdAt' | 'updatedAt' | 'firstName';
        sortOrder?: 'ASC' | 'DESC';
    }): Promise<{ data: User[], total: number, page: number, pageSize: number, totalPages: number }>;
    
    /**
     * Soft deletes a user by ID.
     */
    deleteById(id: string): Promise<boolean>;
}
