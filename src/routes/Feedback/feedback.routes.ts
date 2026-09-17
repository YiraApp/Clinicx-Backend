import { Router } from "express";
import { feedbackController } from "../../controllers/Feedback/feedback.controller.js";

const feedbackRouter = Router();

// Public feedback submission endpoint
feedbackRouter.post("/", feedbackController.submitFeedback.bind(feedbackController));

// Public user context resolution (for pre-populating user-wise personalized feedback links)
feedbackRouter.get("/user-context/:userId", feedbackController.getUserContext.bind(feedbackController));

// Public default organization & hospital context
feedbackRouter.get("/default-context", feedbackController.getDefaultContext.bind(feedbackController));

// Feedback queries & analytics
feedbackRouter.get("/stats", feedbackController.getFeedbackStats.bind(feedbackController));
feedbackRouter.get("/", feedbackController.getFeedbacks.bind(feedbackController));
feedbackRouter.patch("/:id/status", feedbackController.updateStatus.bind(feedbackController));

export { feedbackRouter };
