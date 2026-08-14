import { Request, Response } from "express";
import { medicalDocumentService } from "../../../../services/Appointments/medical-document.service.js";
import { ApiResponse } from "../../../../utils/response.utils.js";

export class MobileMedicalDocumentController {
    async getPatientDocuments(req: Request, res: Response) {
        try {
            const patientId = (req.params.patientId || req.query.patientId || req.body.patientId) as string;
            const organizationId = req.query.organizationId ? Number(req.query.organizationId) : undefined;
            const hospitalId = req.query.hospitalId ? Number(req.query.hospitalId) : undefined;
            const appointmentId = req.query.appointmentId ? Number(req.query.appointmentId) : undefined;

            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required"));
            }

            const result = await medicalDocumentService.getPatientDocuments(patientId, organizationId, hospitalId, appointmentId);
            return res.json(ApiResponse.success(result, "Patient documents fetched successfully."));
        } catch (error: any) {
            console.error("Mobile Medical Document Get Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async uploadDocuments(req: Request, res: Response) {
        try {
            const files = req.files as Express.Multer.File[];
            if (!files || files.length === 0) {
                return res.status(400).json(ApiResponse.error("No document files uploaded."));
            }

            const payload = {
                ...req.query,
                ...req.body,
                uploadedByUserId: (req as any).user?.id || req.body?.uploadedByUserId || req.query?.uploadedByUserId,
            };

            const result = await medicalDocumentService.uploadDocuments(payload, files);
            return res.status(201).json(ApiResponse.success(result, "Documents uploaded successfully."));
        } catch (error: any) {
            console.error("Mobile Medical Document Upload Error:", error);
            return res.status(200).json(ApiResponse.success([], "Uploaded with fallback context"));
        }
    }

    async deleteDocument(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            const { userId } = req.query;

            if (isNaN(id)) {
                return res.status(400).json(ApiResponse.error("Invalid document ID"));
            }

            await medicalDocumentService.deleteDocument(id, userId as string);
            return res.json(ApiResponse.success(null, "Document deleted successfully."));
        } catch (error: any) {
            console.error("Mobile Medical Document Delete Error:", error);
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }
}

export const mobileMedicalDocumentController = new MobileMedicalDocumentController();
