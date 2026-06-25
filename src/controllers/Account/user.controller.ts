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
            const hospitalId = req.query.hospitalId ? parseInt(req.query.hospitalId as string) : undefined;
            const status = req.query.status !== undefined ? req.query.status === 'true' : undefined;
            const fromDate = req.query.fromDate ? new Date(req.query.fromDate as string) : undefined;
            const toDate = req.query.toDate ? new Date(req.query.toDate as string) : undefined;
            const sortBy = (req.query.sortBy as 'createdAt' | 'updatedAt' | 'firstName') || 'createdAt';
            const sortOrder = (req.query.sortOrder as 'ASC' | 'DESC') || 'DESC';

            const currentUserId = (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id;

            const filters = {
                search,
                roleId,
                organizationId,
                hospitalId,
                status,
                fromDate,
                toDate,
                sortBy,
                sortOrder,
                currentUserId
            };

            const result = await userService.getUsers(page, pageSize, filters);
            res.json(ApiResponse.success(result, "Users fetched successfully."));
        } catch (error: any) {
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Fetches users specifically within an organization.
     */
    async getOrgUsers(req: Request, res: Response): Promise<void> {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const pageSize = parseInt(req.query.pageSize as string) || 10;
            const search = (req.query.search as string) || undefined;
            const roleId = (req.query.roleId as string) || undefined;
            const hospitalId = (req.query.hospitalId as string) || undefined;
            const headerOrgId = req.headers["x-org-id"] as string;

            // Force organization ID from header for security
            if (!headerOrgId) {
                res.status(403).json(ApiResponse.error("Organization identification missing."));
                return;
            }

            const organizationId = parseInt(headerOrgId);
            const status = req.query.status !== undefined ? req.query.status === 'true' : undefined;
            const sortBy = (req.query.sortBy as 'createdAt' | 'updatedAt' | 'firstName') || 'createdAt';
            const sortOrder = (req.query.sortOrder as 'ASC' | 'DESC') || 'DESC';

            const currentUserId = (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id;

            const filters = {
                search,
                roleId,
                hospitalId,
                organizationId,
                status,
                sortBy,
                sortOrder,
                currentUserId
            };

            const result = await userService.getOrgUsers(page, pageSize, filters);
            res.json(ApiResponse.success(result, "Organization users fetched successfully."));
        } catch (error: any) {
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Fetches users specifically within a hospital.
     */
    async getHospUsers(req: Request, res: Response): Promise<void> {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const pageSize = parseInt(req.query.pageSize as string) || 10;
            const search = (req.query.search as string) || undefined;
            const roleId = (req.query.roleId as string) || undefined;
            
            const headerOrgId = req.headers["x-org-id"] as string;
            const headerHospId = req.headers["x-hosp-id"] as string;

            if (!headerOrgId || !headerHospId) {
                res.status(403).json(ApiResponse.error("Organization or Hospital identification missing."));
                return;
            }

            const organizationId = parseInt(headerOrgId);
            const hospitalId = parseInt(headerHospId);
            const status = req.query.status !== undefined ? req.query.status === 'true' : undefined;
            const sortBy = (req.query.sortBy as 'createdAt' | 'updatedAt' | 'firstName') || 'createdAt';
            const sortOrder = (req.query.sortOrder as 'ASC' | 'DESC') || 'DESC';

            const currentUserId = (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id;

            const filters = {
                search,
                roleId,
                hospitalId,
                organizationId,
                status,
                sortBy,
                sortOrder,
                currentUserId
            };

            const result = await userService.getHospUsers(page, pageSize, filters);
            res.json(ApiResponse.success(result, "Hospital users fetched successfully."));
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

            const result = await userService.getPrimaryAccount(phoneNumber as string);
            res.json(ApiResponse.success(result, "Primary account check completed."));
        } catch (error: any) {
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Toggles a user's activation status.
     * Body: { status: boolean }
     */
    async toggleStatus(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const { status } = req.body;

            if (!id || typeof status !== "boolean") {
                res.status(400).json(ApiResponse.error("Valid User ID and status (boolean) are required."));
                return;
            }

            await userService.toggleStatus(id as string, status);
            res.json(ApiResponse.success(null, `User ${status ? 'activated' : 'deactivated'} successfully.`));
        } catch (error: any) {
            res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async exportUsers(req: Request, res: Response): Promise<void> {
        try {
            const search = (req.query.search as string) || undefined;
            const roleId = (req.query.roleId as string) || undefined;
            const organizationId = req.query.organizationId ? parseInt(req.query.organizationId as string) : undefined;
            const hospitalId = req.query.hospitalId ? parseInt(req.query.hospitalId as string) : undefined;
            const status = req.query.status !== undefined ? req.query.status === 'true' : undefined;

            const currentUserId = (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id;
            const filters = { search, roleId, organizationId, hospitalId, status, currentUserId };
            const users = await userService.exportUsers(filters);

            if (users.length === 0) {
                res.status(404).json(ApiResponse.error("No users found to export."));
                return;
            }

            // Generate CSV
            const headers = Object.keys(users[0]).join(",");
            const rows = users.map(user => {
                return Object.values(user).map(value => {
                    const strValue = value === null || value === undefined ? "" : String(value);
                    // Escape double quotes and wrap in quotes
                    return `"${strValue.replace(/"/g, '""')}"`;
                }).join(",");
            });

            const csvContent = [headers, ...rows].join("\n");

            res.setHeader("Content-Type", "text/csv");
            res.setHeader("Content-Disposition", `attachment; filename=users_export_${Date.now()}.csv`);
            res.status(200).send(csvContent);
        } catch (error: any) {
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Updates a user's password.
     * Body: { userId: string, newPassword: string }
     */
    async updatePassword(req: Request, res: Response): Promise<void> {
        try {
            const { userId, newPassword } = req.body;

            if (!userId || !newPassword) {
                res.status(400).json(ApiResponse.error("User ID and new password are required."));
                return;
            }

            await userService.updatePassword(userId, newPassword);
            res.json(ApiResponse.success(null, "Password updated successfully."));
        } catch (error: any) {
            res.status(400).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Fetches details of the authenticated patient's profile.
     */
    async getPatientProfile(req: Request, res: Response): Promise<void> {
        try {
            const currentUserId = (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id;
            if (!currentUserId) {
                res.status(401).json(ApiResponse.error("Authentication required."));
                return;
            }

            const result = await userService.getPatientProfile(currentUserId);
            res.json(ApiResponse.success(result, "Patient profile details fetched successfully."));
        } catch (error: any) {
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Updates details of the authenticated patient's profile.
     */
    async updatePatientProfile(req: Request, res: Response): Promise<void> {
        try {
            const currentUserId = (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id;
            if (!currentUserId) {
                res.status(401).json(ApiResponse.error("Authentication required."));
                return;
            }

            const result = await userService.updatePatientProfile(currentUserId, req.body);
            res.json(ApiResponse.success(result, "Patient profile details updated successfully."));
        } catch (error: any) {
            res.status(400).json(ApiResponse.error(error.message));
        }
    }
}

export const userController = new UserController();
