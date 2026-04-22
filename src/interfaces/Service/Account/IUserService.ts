import type { CreateUserRequest } from "../../../dtos/Request/Account/CreateUserRequest.js";
import type { CreateUserResponse } from "../../../dtos/Response/Account/CreateUserResponse.js";

/**
 * Interface for User Service operations.
 */
export interface IUserService {
    /**
     * Creates a new user (Primary or Secondary).
     * Applies business rules for family accounts (max 6 users per phone).
     */
    createUser(data: CreateUserRequest, isEntityUser?: boolean): Promise<CreateUserResponse>;

    /**
     * Gets all users with comprehensive filtering and pagination.
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
    }): Promise<any>;
    
    /**
     * Updates an existing user and manages roles safely.
     */
    updateUser(data: any): Promise<any>;

    /**
     * Checks if a primary account exists for the given phone number.
     */
    getPrimaryAccount(phoneNumber: string): Promise<any>;

    /**
     * Toggles a user's activation status.
     */
    toggleStatus(id: string, status: boolean): Promise<void>;

    /**
     * Gets users scoped to an organization.
     */
    getOrgUsers(page: number, pageSize: number, filters: any): Promise<any>;

    /**
     * Gets users scoped to a specific hospital.
     */
    getHospUsers(page: number, pageSize: number, filters: any): Promise<any>;
}
