import { Request, Response } from "express";
import { doctorSuggestionService } from "../../../../services/Appointments/doctor-suggestion.service.js";
import { ApiResponse } from "../../../../utils/response.utils.js";

export class MobileDoctorSuggestionController {
    async getPatientSuggestions(req: Request, res: Response) {
        try {
            const patientId = (req.params.patientId || req.query.patientId || req.body.patientId) as string;
            const { orgId, hospitalId } = req.query;

            const parsedOrgId = orgId ? parseInt(String(orgId)) : undefined;
            const parsedHospitalId = hospitalId ? parseInt(String(hospitalId)) : undefined;

            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required"));
            }

            const suggestions = await doctorSuggestionService.getPatientSuggestions(
                patientId,
                isNaN(parsedOrgId as any) ? undefined : parsedOrgId,
                isNaN(parsedHospitalId as any) ? undefined : parsedHospitalId
            );

            return res.json(ApiResponse.success(suggestions, "Doctor suggestions fetched successfully"));
        } catch (error: any) {
            console.error("Mobile Doctor Suggestion Get Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async addSuggestion(req: Request, res: Response) {
        try {
            const { doctorId, patientId, title, description, organizationId, hospitalId } = req.body;

            if (!patientId || !title || !description) {
                return res.status(400).json(ApiResponse.error("Patient ID, title, and description are required"));
            }

            const effectiveDoctorId = doctorId || (req as any).user?.userId;

            // Handle optional file upload to Azure Blob Storage
            let filePath: string | undefined;
            let fileName: string | undefined;
            if (req.file) {
                fileName = req.file.originalname;
                try {
                    const { blobService } = await import("../../../../services/Common/blob.service.js");
                    const uploadResults = await blobService.uploadFiles([req.file], String(patientId || "patient"), "doctor-suggestions");
                    if (uploadResults && uploadResults.length > 0 && uploadResults[0].fileUrl) {
                        filePath = uploadResults[0].fileUrl;
                    }
                } catch (blobErr: any) {
                    console.error("[DoctorSuggestionController] Azure upload failed:", blobErr.message);
                }
            }

            const result = await doctorSuggestionService.addSuggestion({
                doctorId: effectiveDoctorId,
                patientId,
                title,
                description,
                filePath,
                fileName,
                organizationId: organizationId ? parseInt(String(organizationId)) : undefined,
                hospitalId: hospitalId ? parseInt(String(hospitalId)) : undefined,
            });

            // Trigger Push Notification to Patient
            try {
                const { pushNotificationService } = await import("../../../../services/Notifications/push-notification.service.js");
                const { AppDataSource } = await import("../../../../config/database.js");
                const { User } = await import("../../../../models/Account/user.model.js");

                let doctorName = "Your doctor";
                if (effectiveDoctorId) {
                    const userRepo = AppDataSource.getRepository(User);
                    const doc = await userRepo.findOne({ where: { Id: effectiveDoctorId } });
                    if (doc) doctorName = `${doc.FirstName || ""} ${doc.LastName || ""}`.trim();
                }

                await pushNotificationService.notifyDoctorSuggestionAdded({
                    patientId,
                    doctorId: effectiveDoctorId,
                    doctorName,
                    suggestionTitle: title,
                    suggestionId: result.Id,
                });
            } catch (notifErr: any) {
                console.error("[DoctorSuggestionController] Push notification warning:", notifErr?.message || notifErr);
            }

            return res.status(201).json(ApiResponse.success(result, "Suggestion added successfully"));
        } catch (error: any) {
            console.error("Mobile Doctor Suggestion Add Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async deleteSuggestion(req: Request, res: Response) {
        try {
            const { id } = req.params;
            if (!id) {
                return res.status(400).json(ApiResponse.error("Suggestion ID is required"));
            }

            await doctorSuggestionService.deleteSuggestion(parseInt(String(id)));
            return res.json(ApiResponse.success(null, "Suggestion deleted successfully"));
        } catch (error: any) {
            console.error("Mobile Doctor Suggestion Delete Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const mobileDoctorSuggestionController = new MobileDoctorSuggestionController();
