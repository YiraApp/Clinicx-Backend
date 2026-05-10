import { Request, Response } from "express";
import { postVisitService } from "../../services/Appointments/post-visit.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class PostVisitController {
    /**
     * Upload clinical documents and generate a share link
     */
    async uploadDocuments(req: Request, res: Response) {
        try {
            const appointmentId = parseInt(req.params.appointmentId as string);
            const files = req.files as Express.Multer.File[];

            if (isNaN(appointmentId)) {
                return res.status(400).json(ApiResponse.error("Invalid Appointment ID."));
            }

            if (!files || files.length === 0) {
                return res.status(400).json(ApiResponse.error("No documents provided for upload."));
            }

            const channel = req.body.channel as string;
            const result = await postVisitService.processDocuments(appointmentId, files, channel);
            return res.json(ApiResponse.success(result, "Documents uploaded and share link generated successfully."));
        } catch (error: any) {
            console.error("Error in PostVisitController (upload):", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    /**
     * Get shared documents using a token
     */
    async getSharedSummary(req: Request, res: Response) {
        try {
            const { token } = req.params;
            if (!token) {
                return res.status(400).json(ApiResponse.error("Share token is required."));
            }

            const documents = await postVisitService.getSharedDocuments(token);
            return res.json(ApiResponse.success(documents, "Shared documents retrieved successfully."));
        } catch (error: any) {
            console.error("Error in PostVisitController (getSharedSummary):", error);
            return res.status(404).json(ApiResponse.error(error.message));
        }
    }
}

export const postVisitController = new PostVisitController();
