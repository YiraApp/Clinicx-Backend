import type { Request, Response } from "express";
import { AppDataSource } from "../../../config/database.js";
import { AppNotification } from "../../../models/Common/app-notification.model.js";
import { ApiResponse } from "../../../utils/response.utils.js";

export class NotificationController {
    private notificationRepo = AppDataSource.getRepository(AppNotification);

    /**
     * Retrieves recent notifications for the authenticated user.
     */
    getNotifications = async (req: Request, res: Response) => {
        try {
            const userId = (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id || req.body?.userId;

            if (!userId) {
                return res.status(200).json(ApiResponse.error("User ID not found in session"));
            }

            const page = parseInt(req.query.page as string || "1", 10);
            const limit = parseInt(req.query.limit as string || "30", 10);
            const skip = (page - 1) * limit;

            const [notifications, total] = await this.notificationRepo.findAndCount({
                where: { UserId: userId },
                order: { CreatedAt: "DESC" },
                skip,
                take: limit,
            });

            const unreadCount = await this.notificationRepo.count({
                where: { UserId: userId, IsRead: false }
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
            if (userId) query.UserId = userId;

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
     * Marks all unread notifications for the user as read.
     */
    markAllAsRead = async (req: Request, res: Response) => {
        try {
            const userId = (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id || req.body?.userId;

            if (!userId) {
                return res.status(400).json(ApiResponse.error("User ID not found"));
            }

            await this.notificationRepo.update(
                { UserId: userId, IsRead: false },
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
