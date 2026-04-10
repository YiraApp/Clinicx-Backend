import type { Request, Response } from "express";
import { userService } from "../../services/Account/user.service.js";
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
}

export const userController = new UserController();
