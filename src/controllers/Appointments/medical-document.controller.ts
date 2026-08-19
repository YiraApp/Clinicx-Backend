import { Request, Response } from "express";
import { medicalDocumentService } from "../../services/Appointments/medical-document.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class MedicalDocumentController {
    async upload(req: Request, res: Response) {
        try {
            const files = req.files as Express.Multer.File[];
            const result = await medicalDocumentService.uploadDocuments(req.body, files);
            return res.json(ApiResponse.success(result, "Documents uploaded successfully."));
        } catch (error: any) {
            console.error("[MedicalDocumentController] Upload Error:", error);
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async getByPatient(req: Request, res: Response) {
        try {
            const patientId = req.params.patientId as string;
            const organizationId = req.query.organizationId ? Number(req.query.organizationId) : undefined;
            const hospitalId = req.query.hospitalId ? Number(req.query.hospitalId) : undefined;
            const appointmentId = req.query.appointmentId ? Number(req.query.appointmentId) : undefined;

            if (!patientId) return res.status(400).json(ApiResponse.error("Patient ID is required"));

            const result = await medicalDocumentService.getPatientDocuments(patientId, organizationId, hospitalId, appointmentId);
            return res.json(ApiResponse.success(result, "Patient documents fetched successfully."));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async delete(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            const { userId } = req.query; // Assuming userId is passed or retrieved from auth

            if (isNaN(id)) return res.status(400).json(ApiResponse.error("Invalid document ID"));

            await medicalDocumentService.deleteDocument(id, userId as string);
            return res.json(ApiResponse.success(null, "Document deleted successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async generateUploadLink(req: Request, res: Response) {
        try {
            const appointmentId = parseInt(req.params.appointmentId as string);
            if (isNaN(appointmentId)) {
                return res.status(400).json(ApiResponse.error("Valid Appointment ID is required."));
            }

            const createdBy = req.body?.createdBy || "PATIENT";
            const result = await medicalDocumentService.generateUploadLink(appointmentId, createdBy);
            return res.json(ApiResponse.success(result, "Upload link generated successfully."));
        } catch (error: any) {
            console.error("[MedicalDocumentController] generateUploadLink Error:", error);
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async getUploadLinkInfo(req: Request, res: Response) {
        try {
            const token = req.params.token as string;
            if (!token) {
                return res.status(400).json(ApiResponse.error("Token is required."));
            }

            const result = await medicalDocumentService.getUploadLinkInfo(token);
            return res.json(ApiResponse.success(result, "Upload link info retrieved successfully."));
        } catch (error: any) {
            console.error("[MedicalDocumentController] getUploadLinkInfo Error:", error);
            return res.status(404).json(ApiResponse.error(error.message));
        }
    }

    async uploadByLink(req: Request, res: Response) {
        try {
            const token = req.params.token as string;
            const files = req.files as Express.Multer.File[];

            if (!token) {
                return res.status(400).json(ApiResponse.error("Upload token is required."));
            }

            if (!files || files.length === 0) {
                return res.status(400).json(ApiResponse.error("No documents provided for upload."));
            }

            const result = await medicalDocumentService.uploadDocumentsByLink(token, req.body, files);
            return res.json(ApiResponse.success(result, "Documents uploaded successfully via link."));
        } catch (error: any) {
            console.error("[MedicalDocumentController] uploadByLink Error:", error);
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }
}

export const medicalDocumentController = new MedicalDocumentController();
