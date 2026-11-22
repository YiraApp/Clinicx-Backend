import { Request, Response } from "express";
import { medicalDocumentService } from "../../services/Appointments/medical-document.service.js";
import { ApiResponse } from "../../utils/response.utils.js";
import { AppDataSource } from "../../config/database.js";
import { MedicalDocument } from "../../models/Appointments/medical-document.model.js";
import { canDeleteDocument, canOpenDocument } from "../../utils/document-access.js";
import { requireTokenActor, sameUserId } from "../../utils/request-actor.js";
import { workingAccountId } from "../../utils/work-access.js";

const findDocument = (id: number) =>
    AppDataSource.getRepository(MedicalDocument).findOne({ where: { Id: id, IsDeleted: false } as any });

export class MedicalDocumentController {

    async sendAppointmentBooking(req: Request, res: Response) {
        try {
            const { patientId, hospitalId, senderId } = req.body;
            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required."));
            }
            const result = await medicalDocumentService.sendAppointmentBookingWhatsApp(
                patientId,
                hospitalId ? Number(hospitalId) : undefined,
                senderId
            );
            return res.json(ApiResponse.success(result, "Appointment booking WhatsApp notification sent."));
        } catch (error: any) {
            console.error("[MedicalDocumentController] sendAppointmentBooking Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async sendDentalConsultation(req: Request, res: Response) {
        try {
            const { patientId, senderId } = req.body;
            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required."));
            }
            const result = await medicalDocumentService.sendDentalConsultationWhatsApp(patientId, senderId);
            return res.json(ApiResponse.success(result, "Dental Consultation WhatsApp notification sent."));
        } catch (error: any) {
            console.error("[MedicalDocumentController] sendDentalConsultation Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }


    async sendEyeConsultation(req: Request, res: Response) {
        try {
            const { patientId, senderId } = req.body;
            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required."));
            }
            const result = await medicalDocumentService.sendEyeConsultationWhatsApp(patientId, senderId);
            return res.json(ApiResponse.success(result, "Eye Consultation WhatsApp notification sent."));
        } catch (error: any) {
            console.error("[MedicalDocumentController] sendEyeConsultation Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }


    async scheduleHomeSample(req: Request, res: Response) {
        try {
            const { patientId, date, time, senderId } = req.body;
            if (!patientId || !date || !time) {
                return res.status(400).json(ApiResponse.error("Patient ID, Date, and Time are required."));
            }
            const result = await medicalDocumentService.scheduleHomeSampleCollection(patientId, date, time, senderId);
            return res.json(ApiResponse.success(result, "Home Sample Collection scheduled and WhatsApp template sent."));
        } catch (error: any) {
            console.error("[MedicalDocumentController] scheduleHomeSample Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }


    async shareSingle(req: Request, res: Response) {
        try {
            const { documentId, patientId } = req.body;
            if (!documentId || !patientId) {
                return res.status(400).json(ApiResponse.error("Document ID and Patient ID are required."));
            }
            if (!requireTokenActor(req, res)) return;
            const doc = await findDocument(Number(documentId));
            if (!doc) return res.status(404).json(ApiResponse.error("Document not found."));
            if (!sameUserId(String(doc.PatientId || ""), String(patientId))) {
                return res.status(400).json(ApiResponse.error("This document belongs to another patient."));
            }
            if (!(await canOpenDocument(req, doc))) {
                return res.status(403).json(ApiResponse.error("You can only send documents you can see for this patient."));
            }
            const senderId = (await workingAccountId(req)) ?? undefined;
            const result = await medicalDocumentService.shareSingleDocument(Number(documentId), patientId, senderId);
            return res.json(ApiResponse.success(result, "Document shared via WhatsApp successfully."));
        } catch (error: any) {
            console.error("[MedicalDocumentController] shareSingle Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }


    async notifyPatient(req: Request, res: Response) {
        try {
            const { patientId, senderId } = req.body;
            if (!patientId) return res.status(400).json(ApiResponse.error("Patient ID is required."));
            const result = await medicalDocumentService.notifyPatientMedicalRecord(patientId, senderId);
            return res.json(ApiResponse.success(result, "WhatsApp notification sent successfully."));
        } catch (error: any) {
            console.error("[MedicalDocumentController] notifyPatient Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async getNotifications(req: Request, res: Response) {
        try {
            const patientId = (req.params.patientId || req.query.patientId) as string;
            if (!patientId) return res.status(400).json(ApiResponse.error("Patient ID is required."));
            const result = await medicalDocumentService.getNotificationHistory(patientId);
            return res.json(ApiResponse.success(result, "Notification history fetched successfully."));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

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

            // Set by requirePatientRecordAccess: a doctor without the patient's consent sees only his own documents.
            const doctorId: string | undefined = res.locals.recordDoctorId;
            const result = await medicalDocumentService.getPatientDocuments(patientId, organizationId, hospitalId, appointmentId, undefined, undefined, doctorId);
            return res.json(ApiResponse.success(result, "Patient documents fetched successfully."));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async delete(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            if (isNaN(id)) return res.status(400).json(ApiResponse.error("Invalid document ID"));
            if (!requireTokenActor(req, res)) return;
            const doc = await findDocument(id);
            if (!doc) return res.status(404).json(ApiResponse.error("Document not found."));
            if (!(await canDeleteDocument(req, doc))) {
                return res.status(403).json(ApiResponse.error("You can only delete documents you added or that your hospital holds."));
            }
            // Who deleted it comes from the login, not from a query parameter.
            const deletedBy = (await workingAccountId(req)) ?? undefined;
            await medicalDocumentService.deleteDocument(id, deletedBy as string);
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
