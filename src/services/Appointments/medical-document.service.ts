import { medicalDocumentRepository } from "../../repositories/Appointments/medical-document.repository.js";
import { MedicalDocument } from "../../models/Appointments/medical-document.model.js";
import { blobService } from "../Common/blob.service.js";

export class MedicalDocumentService {
    async uploadDocuments(data: any, files: Express.Multer.File[]): Promise<MedicalDocument[]> {
        const {
            appointmentId,
            patientId,
            doctorId,
            organizationId,
            hospitalId,
            documentCategory,
            documentType,
            description,
            tags,
            uploadedByUserId,
            isPatientUploaded,
            isDoctorUploaded
        } = data;

        if (!patientId || !organizationId || !hospitalId || !files || files.length === 0) {
            throw new Error("Missing required fields or files for document upload.");
        }

        // 1. Upload to Azure Blob Storage
        // Use patientId as the folder name
        const uploadResults = await blobService.uploadFiles(files, patientId, "medical-documents");

        const savedDocuments: MedicalDocument[] = [];

        // 2. Create records in database
        for (const res of uploadResults) {
            const document = new MedicalDocument();
            document.AppointmentId = appointmentId ? Number(appointmentId) : undefined;
            document.PatientId = patientId;
            document.DoctorId = doctorId;
            document.OrganizationId = Number(organizationId);
            document.HospitalId = Number(hospitalId);
            document.DocumentCategory = documentCategory || "General";
            document.DocumentType = documentType || res.fileType.replace(".", "").toUpperCase();
            document.FileName = res.fileName;
            document.OriginalFileName = res.fileName;
            document.BlobUrl = res.fileUrl; // Azure URL
            document.MimeType = files.find(f => f.originalname === res.fileName)?.mimetype;
            document.FileExtension = res.fileType;
            document.FileSize = files.find(f => f.originalname === res.fileName)?.size;
            document.Description = description;
            document.Tags = tags;
            document.UploadedByUserId = uploadedByUserId;
            document.IsPatientUploaded = isPatientUploaded === "true" || isPatientUploaded === true;
            document.IsDoctorUploaded = isDoctorUploaded === "true" || isDoctorUploaded === true;
            document.IsSystemGenerated = false;
            document.CreatedBy = uploadedByUserId;

            const savedDoc = await medicalDocumentRepository.save(document);
            savedDocuments.push(savedDoc);
        }

        return savedDocuments;
    }

    async getPatientDocuments(patientId: string, organizationId?: number, hospitalId?: number, appointmentId?: number): Promise<MedicalDocument[]> {
        return await medicalDocumentRepository.findByPatient(patientId, organizationId, hospitalId, appointmentId);
    }

    async deleteDocument(id: number, userId?: string): Promise<void> {
        await medicalDocumentRepository.softDelete(id, userId);
    }
}

export const medicalDocumentService = new MedicalDocumentService();
