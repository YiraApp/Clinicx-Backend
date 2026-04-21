import type { Request, Response } from "express";
import { userService } from "../../services/Account/user.service.js";
import { ApiResponse } from "../../utils/response.utils.js";
import { OTPPurpose } from "../../enums/OTPType.enum.js";
import type { CreateUserRequest } from "../../dtos/Request/Account/CreateUserRequest.js";

/**
 * Controller for User-related operations.
 */
export class UserController {
    /**
     * Handles user registration.
     */
    async register(req: Request, res: Response): Promise<void> {
        try {
            const userData: CreateUserRequest = req.body;

            // Simple validation check
            if (!userData.PhoneNumber || !userData.FirstName) {
                res.status(400).json({ error: "PhoneNumber and FirstName are required." });
                return;
            }

            const result = await userService.createUser(userData);
            res.status(201).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * Fetches all users with advanced filtering and pagination.
     * Supports: search, role, organization, status, date range filters, and sorting.
     */
    async getUsers(req: Request, res: Response): Promise<void> {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const pageSize = parseInt(req.query.pageSize as string) || 10;
            const search = (req.query.search as string) || undefined;
            const roleId = (req.query.roleId as string) || undefined;
            const organizationId = req.query.organizationId ? parseInt(req.query.organizationId as string) : undefined;
            const status = req.query.status !== undefined ? req.query.status === 'true' : undefined;
            const fromDate = req.query.fromDate ? new Date(req.query.fromDate as string) : undefined;
            const toDate = req.query.toDate ? new Date(req.query.toDate as string) : undefined;
            const sortBy = (req.query.sortBy as 'createdAt' | 'updatedAt' | 'firstName') || 'createdAt';
            const sortOrder = (req.query.sortOrder as 'ASC' | 'DESC') || 'DESC';

            const filters = {
                search,
                roleId,
                organizationId,
                status,
                fromDate,
                toDate,
                sortBy,
                sortOrder
            };

            const result = await userService.getUsers(page, pageSize, filters);
            res.json(ApiResponse.success(result, "Users fetched successfully."));
        } catch (error: any) {
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Handles user updates and role synchronization.
     */
    async updateUser(req: Request, res: Response): Promise<void> {
        try {
            const result = await userService.updateUser(req.body);
            res.json(ApiResponse.success(result, "User updated successfully."));
        } catch (error: any) {
            res.status(400).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Checks if a primary account exists for the given phone number.
     */
    async getPrimaryAccount(req: Request, res: Response): Promise<void> {
        try {
            const { phoneNumber } = req.params;
            if (!phoneNumber) {
                res.status(400).json(ApiResponse.error("Phone number is required."));
                return;
            }

            const result = await userService.getPrimaryAccount(phoneNumber);
            res.json(ApiResponse.success(result, "Primary account check completed."));
        } catch (error: any) {
            res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const userController = new UserController();
