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
}
