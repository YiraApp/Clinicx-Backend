import { Request, Response } from "express";
import { blobService } from "../../services/Common/blob.service.js";

export class FileController {
    /**
     * Handles file uploads to Azure Blob Storage.
     * Expects multipart/form-data with 'files' field.
     */
    async uploadFiles(req: Request, res: Response): Promise<void> {
        try {
            const files = req.files as Express.Multer.File[];
            const userName = req.body.userName || "general";
            const serviceConstant = req.body.serviceConstant || "uploads";

            if (!files || files.length === 0) {
                res.status(400).json({ error: "No files uploaded." });
                return;
            }

            const results = await blobService.uploadFiles(files, userName, serviceConstant);

            res.status(200).json({
                message: "Files uploaded successfully",
                data: results
            });
        } catch (error: any) {
            console.error("[File Controller] Upload error:", error.message);
            res.status(500).json({ error: "Failed to upload files", detail: error.message });
        }
    }
}

export const fileController = new FileController();
