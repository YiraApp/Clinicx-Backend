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
}
