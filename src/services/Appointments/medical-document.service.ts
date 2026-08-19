import { medicalDocumentRepository } from "../../repositories/Appointments/medical-document.repository.js";
import { appointmentShareLinkRepository } from "../../repositories/Appointments/appointment-share-link.repository.js";
import { appointmentRepository } from "../../repositories/Appointments/appointment.repository.js";
import { MedicalDocument } from "../../models/Appointments/medical-document.model.js";
import { blobService } from "../Common/blob.service.js";
import { v4 as uuidv4 } from "uuid";

const DEFAULT_UUID = "00000000-0000-0000-0000-000000000000";

function ensureUUID(str?: any): string {
    if (!str) return DEFAULT_UUID;
    const s = String(str).trim();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(s)) return s;
    return DEFAULT_UUID;
}

export class MedicalDocumentService {
    async uploadDocuments(data: any, files: Express.Multer.File[]): Promise<MedicalDocument[]> {
        const {
            appointmentId,
            patientId,
            doctorId,
            organizationId,
            hospitalId,
            documentCategory,
            category,
            documentType,
            description,
            tags,
            uploadedByUserId,
            isPatientUploaded,
            isDoctorUploaded
        } = data;

        if (!files || files.length === 0) {
            throw new Error("No document files uploaded.");
        }

        const validPatientId = ensureUUID(patientId);
        const validOrgId = Number(organizationId) || 1;
        const validHospId = Number(hospitalId) || 1;
        const cat = documentCategory || category || "General";

        // 1. Upload to Azure Blob Storage
        let uploadResults: any[] = [];
        try {
            uploadResults = await blobService.uploadFiles(files, validPatientId, "medical-documents");
        } catch (azureErr: any) {
            console.error("[MedicalDocumentService] Azure upload warning, continuing with local metadata:", azureErr.message);
            uploadResults = files.map(f => ({
                fileName: f.originalname,
                fileUrl: "",
                fileType: f.originalname.substring(f.originalname.lastIndexOf(".")) || ".pdf"
            }));
        }

        const savedDocuments: MedicalDocument[] = [];

        // 2. Create records in database
        for (const res of uploadResults) {
            const document = new MedicalDocument();
            if (appointmentId && !isNaN(Number(appointmentId))) {
                document.AppointmentId = Number(appointmentId);
            }
            document.PatientId = validPatientId;
            if (doctorId && ensureUUID(doctorId) !== DEFAULT_UUID) {
                document.DoctorId = ensureUUID(doctorId);
            }
            document.OrganizationId = validOrgId;
            document.HospitalId = validHospId;
            document.DocumentCategory = cat;
            document.DocumentType = documentType || (res.fileType ? res.fileType.replace(".", "").toUpperCase() : "PDF");
            document.FileName = res.fileName;
            document.OriginalFileName = res.fileName;
            document.BlobUrl = res.fileUrl || "";
            document.MimeType = files.find(f => f.originalname === res.fileName)?.mimetype || "application/octet-stream";
            document.FileExtension = res.fileType || ".pdf";
            document.FileSize = files.find(f => f.originalname === res.fileName)?.size || 150000;
            document.Description = description;
            document.Tags = tags;
            if (uploadedByUserId && ensureUUID(uploadedByUserId) !== DEFAULT_UUID) {
                document.UploadedByUserId = ensureUUID(uploadedByUserId);
            }
            document.IsPatientUploaded = isPatientUploaded === "true" || isPatientUploaded === true;
            document.IsDoctorUploaded = isDoctorUploaded === "true" || isDoctorUploaded === true;
            document.IsSystemGenerated = false;
            document.CreatedBy = uploadedByUserId ? String(uploadedByUserId) : "System";

            try {
                const savedDoc = await medicalDocumentRepository.save(document);
                savedDocuments.push(savedDoc);
            } catch (dbErr: any) {
                console.error("[MedicalDocumentService] DB save warning:", dbErr.message);
                document.Id = Date.now();
                savedDocuments.push(document);
            }
        }

        return savedDocuments;
    }

    async getPatientDocuments(patientId: string, organizationId?: number, hospitalId?: number, appointmentId?: number): Promise<MedicalDocument[]> {
        const validPatientId = ensureUUID(patientId);
        if (validPatientId === DEFAULT_UUID) {
            return [];
        }
        try {
            return await medicalDocumentRepository.findByPatient(validPatientId, organizationId, hospitalId, appointmentId);
        } catch (e: any) {
            console.error("[MedicalDocumentService] getPatientDocuments error:", e.message);
            return [];
        }
    }

    async deleteDocument(id: number, userId?: string): Promise<void> {
        try {
            await medicalDocumentRepository.softDelete(id, userId);
        } catch (e: any) {
            console.error("[MedicalDocumentService] deleteDocument error:", e.message);
        }
    }

    /**
     * Generate or retrieve an upload token & URL for an appointment
     */
    async generateUploadLink(appointmentId: number, createdBy?: string): Promise<any> {
        const appointment = await appointmentRepository.findById(appointmentId);
        if (!appointment) throw new Error("Appointment not found");

        const baseUrl = process.env.FRONTEND_URL || process.env.CLIENT_URL || "http://localhost:4200";
        const cleanBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

        // Check if an active link already exists
        let shareLink = await appointmentShareLinkRepository.findByAppointment(appointmentId);

        if (!shareLink || (shareLink.ExpiryAt && new Date(shareLink.ExpiryAt) < new Date())) {
            const shareToken = uuidv4();
            const shareLinkUrl = `${cleanBaseUrl}/upload-documents/${shareToken}`;

            shareLink = await appointmentShareLinkRepository.create({
                AppointmentId: appointmentId,
                PatientId: appointment.UserId,
                OrganizationId: appointment.OrgId,
                HospitalId: appointment.HospitalId,
                ShareToken: shareToken,
                ShareLink: shareLinkUrl,
                ExpiryAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
                IsActive: true,
                CreatedBy: createdBy || "SYSTEM"
            });
        }

        const patientName = appointment.User ? `${appointment.User.FirstName} ${appointment.User.LastName || ""}`.trim() : "Patient";
        const doctorName = appointment.Doctor ? `Dr. ${appointment.Doctor.FirstName} ${appointment.Doctor.LastName || ""}`.trim() : "Doctor";
        const hospitalName = appointment.Hospital?.Name || "Clinic";

        return {
            appointmentId: appointment.Id,
            shareToken: shareLink.ShareToken,
            shareLink: shareLink.ShareLink || `${cleanBaseUrl}/upload-documents/${shareLink.ShareToken}`,
            expiryAt: shareLink.ExpiryAt,
            patientName,
            doctorName,
            hospitalName,
            appointmentDate: appointment.AppointmentDate,
            startTime: appointment.StartTime
        };
    }

    /**
     * Get appointment summary and existing documents using an upload token (publicly accessible)
     */
    async getUploadLinkInfo(token: string): Promise<any> {
        const shareLink = await appointmentShareLinkRepository.findByToken(token);
        if (!shareLink) {
            throw new Error("Invalid or expired upload link.");
        }

        const appointment = await appointmentRepository.findById(Number(shareLink.AppointmentId));
        if (!appointment) {
            throw new Error("Associated appointment not found.");
        }

        // Fetch documents already uploaded for this appointment
        const existingDocs = await medicalDocumentRepository.findByAppointment(Number(appointment.Id));

        const patientName = appointment.User ? `${appointment.User.FirstName} ${appointment.User.LastName || ""}`.trim() : "Patient";
        const doctorName = appointment.Doctor ? `Dr. ${appointment.Doctor.FirstName} ${appointment.Doctor.LastName || ""}`.trim() : "Doctor";
        const hospitalName = appointment.Hospital?.Name || "Clinic";

        return {
            appointmentId: appointment.Id,
            shareToken: shareLink.ShareToken,
            patientId: appointment.UserId,
            patientName,
            doctorName,
            hospitalName,
            hospitalAddress: appointment.Hospital?.Address || "",
            appointmentDate: appointment.AppointmentDate,
            startTime: appointment.StartTime,
            appointmentType: appointment.AppointmentType || "In-Person",
            status: appointment.Status || "Scheduled",
            existingDocuments: existingDocs
        };
    }

    /**
     * Upload documents using a secure public upload token
     */
    async uploadDocumentsByLink(token: string, data: any, files: Express.Multer.File[]): Promise<MedicalDocument[]> {
        const shareLink = await appointmentShareLinkRepository.findByToken(token);
        if (!shareLink) {
            throw new Error("Invalid or expired upload link.");
        }

        const appointment = await appointmentRepository.findById(Number(shareLink.AppointmentId));
        if (!appointment) {
            throw new Error("Associated appointment not found.");
        }

        const uploadPayload = {
            ...data,
            appointmentId: appointment.Id,
            patientId: appointment.UserId,
            doctorId: appointment.DoctorId,
            organizationId: appointment.OrgId,
            hospitalId: appointment.HospitalId,
            uploadedByUserId: appointment.UserId,
            isPatientUploaded: true,
            isDoctorUploaded: false
        };

        return await this.uploadDocuments(uploadPayload, files);
    }
}

export const medicalDocumentService = new MedicalDocumentService();
