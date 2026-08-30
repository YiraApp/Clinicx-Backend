import type { Request, Response } from "express";
import { In } from "typeorm";
import { AppDataSource } from "../../../config/database.js";
import { AppNotification } from "../../../models/Common/app-notification.model.js";
import { User } from "../../../models/Account/user.model.js";
import { ApiResponse } from "../../../utils/response.utils.js";

export class NotificationController {
    private notificationRepo = AppDataSource.getRepository(AppNotification);

    /**
     * Resolves all linked family account user IDs (Primary account + all linked dependents, up to 6 accounts)
     */
    private async getLinkedFamilyUserIds(userId: string): Promise<string[]> {
        const ids = new Set<string>();
        if (!userId) return [];
        ids.add(userId);

        try {
            const userRepo = AppDataSource.getRepository(User);
            const user = await userRepo.findOne({ where: { Id: userId } }).catch(() => null);
            if (!user) return Array.from(ids);

            const cleanPhone = user.PhoneNumber ? user.PhoneNumber.replace(/\D/g, '').slice(-10) : '';
            const parentId = user.ParentUserId || user.Id;

            if (user.ParentUserId) {
                ids.add(user.ParentUserId);
            }

            const familyMembers = await userRepo.createQueryBuilder('u')
                .where('u.IsDeleted = 0')
                .andWhere(
                    '(u.Id = :userId OR u.Id = :parentId OR u.ParentUserId = :parentId OR u.ParentUserId = :userId' +
                    (cleanPhone && cleanPhone.length === 10 ? ' OR RIGHT(REPLACE(u.PhoneNumber, \' \', \'\'), 10) = :cleanPhone' : '') + ')',
                    { userId: user.Id, parentId, cleanPhone }
                )
                .getMany()
                .catch(() => []);

            for (const m of familyMembers) {
                ids.add(m.Id);
            }
        } catch (error) {
            console.error("[NotificationController] Error resolving family user IDs:", error);
        }

        return Array.from(ids);
    }

    /**
     * Retrieves recent notifications for the authenticated user and all linked dependents/family accounts.
     */
    getNotifications = async (req: Request, res: Response) => {
        try {
            const userId = (req.query?.userId as string) || (req.body?.userId as string) || (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id;

            if (!userId) {
                return res.status(200).json(ApiResponse.error("User ID not found in session"));
            }

            const linkedUserIds = await this.getLinkedFamilyUserIds(userId);

            const page = parseInt(req.query.page as string || "1", 10);
            const limit = parseInt(req.query.limit as string || "30", 10);
            const skip = (page - 1) * limit;

            const [notifications, total] = await this.notificationRepo.findAndCount({
                where: { UserId: In(linkedUserIds) },
                order: { CreatedAt: "DESC" },
                skip,
                take: limit,
            });

            const unreadCount = await this.notificationRepo.count({
                where: { UserId: In(linkedUserIds), IsRead: false }
            });

            return res.json(ApiResponse.success({
                notifications: notifications.map(n => ({
                    id: n.Id,
                    userId: n.UserId,
                    senderId: n.SenderId,
                    title: n.Title,
                    body: n.Body,
                    type: n.Type,
                    referenceId: n.ReferenceId,
                    route: n.Route,
                    isRead: n.IsRead,
                    createdAt: n.CreatedAt,
                })),
                total,
                unreadCount,
                page,
                limit
            }, "Notifications retrieved successfully"));
        } catch (error: any) {
            console.error("Error fetching notifications:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to retrieve notifications"));
        }
    };

    /**
     * Marks a specific notification as read.
     */
    markAsRead = async (req: Request, res: Response) => {
        try {
            const { id } = req.params;
            const userId = (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id;

            if (!id) {
                return res.status(400).json(ApiResponse.error("Notification ID is required"));
            }

            const query: any = { Id: id };
            if (userId) {
                const linkedUserIds = await this.getLinkedFamilyUserIds(userId);
                query.UserId = In(linkedUserIds);
            }

            await this.notificationRepo.update(query, {
                IsRead: true,
                UpdatedAt: new Date()
            });

            return res.json(ApiResponse.success(null, "Notification marked as read"));
        } catch (error: any) {
            console.error("Error marking notification as read:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to update notification"));
        }
    };

    /**
     * Marks all unread notifications for the user and all linked family members as read.
     */
    markAllAsRead = async (req: Request, res: Response) => {
        try {
            const userId = (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id || req.body?.userId;

            if (!userId) {
                return res.status(400).json(ApiResponse.error("User ID not found"));
            }

            const linkedUserIds = await this.getLinkedFamilyUserIds(userId);

            await this.notificationRepo.update(
                { UserId: In(linkedUserIds), IsRead: false },
                { IsRead: true, UpdatedAt: new Date() }
            );

            return res.json(ApiResponse.success(null, "All notifications marked as read"));
        } catch (error: any) {
            console.error("Error marking all notifications as read:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to mark notifications as read"));
        }
    };

    /**
     * Dispatches a test push notification and saves to database.
     */
    sendTestNotification = async (req: Request, res: Response) => {
        try {
            const userId = (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id || req.body?.userId;
            const { title, body, type, route } = req.body || {};

            if (!userId) {
                return res.status(400).json(ApiResponse.error("User ID not found"));
            }

            const { PushNotificationService } = await import("../../../services/Notifications/push-notification.service.js");
            const pushService = new PushNotificationService();

            const result = await pushService.sendNotification({
                userId,
                title: title || "🩺 Yira Clinx: Test Push Notification",
                body: body || "Rahul Verma booked an appointment for Today at 10:30 AM.",
                type: type || "TEST_PUSH",
                route: route || "/doctorDashboard",
            });

            return res.json(ApiResponse.success(result, "Test notification dispatched and saved"));
        } catch (error: any) {
            console.error("Error sending test notification:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to dispatch test notification"));
        }
    };
}

export const notificationController = new NotificationController();
