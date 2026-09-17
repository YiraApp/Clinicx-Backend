import { Request, Response } from "express";
import { feedbackService } from "../../services/Feedback/feedback.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class FeedbackController {

    async submitFeedback(req: Request, res: Response) {
        try {
            const {
                userId,
                name,
                phone,
                email,
                rating,
                category,
                message,
                hospitalId,
                organizationId,
                source
            } = req.body;

            if (!name || !String(name).trim()) {
                return res.status(400).json(ApiResponse.error("Name is required."));
            }

            if (!message || !String(message).trim()) {
                return res.status(400).json(ApiResponse.error("Feedback message is required."));
            }

            const feedback = await feedbackService.submitFeedback({
                userId,
                name,
                phone,
                email,
                rating: Number(rating) || 5,
                category,
                message,
                hospitalId: hospitalId ? Number(hospitalId) : undefined,
                organizationId: organizationId ? Number(organizationId) : undefined,
                source
            });

            return res.status(201).json(ApiResponse.success(feedback, "Thank you for your feedback!"));
        } catch (error: any) {
            console.error("[FeedbackController] submitFeedback Error:", error);
            return res.status(400).json(ApiResponse.error(error.message || "Failed to submit feedback."));
        }
    }

    async getUserContext(req: Request, res: Response) {
        try {
            const { userId } = req.params;
            if (!userId) {
                return res.status(400).json(ApiResponse.error("User ID is required."));
            }

            const context = await feedbackService.getUserFeedbackContext(userId);
            if (!context) {
                return res.status(404).json(ApiResponse.error("User not found or invalid ID."));
            }

            return res.json(ApiResponse.success(context, "User context retrieved successfully."));
        } catch (error: any) {
            console.error("[FeedbackController] getUserContext Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async getDefaultContext(req: Request, res: Response) {
        try {
            const context = await feedbackService.getDefaultFeedbackContext();
            return res.json(ApiResponse.success(context, "Default feedback context retrieved successfully."));
        } catch (error: any) {
            console.error("[FeedbackController] getDefaultContext Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async getFeedbacks(req: Request, res: Response) {
        try {
            const orgId = req.query.orgId ? Number(req.query.orgId) : undefined;
            const hospitalId = req.query.hospitalId ? Number(req.query.hospitalId) : undefined;
            const userId = req.query.userId ? String(req.query.userId) : undefined;
            const rating = req.query.rating ? Number(req.query.rating) : undefined;
            const category = req.query.category ? String(req.query.category) : undefined;
            const status = req.query.status ? String(req.query.status) : undefined;
            const search = req.query.search ? String(req.query.search) : undefined;
            const page = req.query.page ? Number(req.query.page) : 1;
            const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 20;

            const result = await feedbackService.getFeedbacks({
                orgId,
                hospitalId,
                userId,
                rating,
                category,
                status,
                search,
                page,
                pageSize
            });

            return res.json(ApiResponse.success(result, "Feedbacks retrieved successfully."));
        } catch (error: any) {
            console.error("[FeedbackController] getFeedbacks Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async getFeedbackStats(req: Request, res: Response) {
        try {
            const orgId = req.query.orgId ? Number(req.query.orgId) : undefined;
            const hospitalId = req.query.hospitalId ? Number(req.query.hospitalId) : undefined;

            const stats = await feedbackService.getFeedbackStats(orgId, hospitalId);
            return res.json(ApiResponse.success(stats, "Feedback statistics calculated successfully."));
        } catch (error: any) {
            console.error("[FeedbackController] getFeedbackStats Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async updateStatus(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id);
            const { status, adminNotes } = req.body;

            if (isNaN(id)) {
                return res.status(400).json(ApiResponse.error("Invalid Feedback ID."));
            }

            if (!status) {
                return res.status(400).json(ApiResponse.error("Status is required."));
            }

            const updated = await feedbackService.updateStatus(id, status, adminNotes);
            if (!updated) {
                return res.status(404).json(ApiResponse.error("Feedback record not found."));
            }

            return res.json(ApiResponse.success(updated, "Feedback status updated successfully."));
        } catch (error: any) {
            console.error("[FeedbackController] updateStatus Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const feedbackController = new FeedbackController();
