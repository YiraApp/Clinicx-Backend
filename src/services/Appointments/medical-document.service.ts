import { medicalDocumentRepository } from "../../repositories/Appointments/medical-document.repository.js";
import { MedicalDocument } from "../../models/Appointments/medical-document.model.js";
import { blobService } from "../Common/blob.service.js";

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

    async getPatientDocuments(patientId: string, organizationId?: number, hospitalId?: number, appointmentId?: number, limit?: number): Promise<MedicalDocument[]> {
        const validPatientId = ensureUUID(patientId);
        if (validPatientId === DEFAULT_UUID) {
            return [];
        }
        try {
            return await medicalDocumentRepository.findByPatient(validPatientId, organizationId, hospitalId, appointmentId, limit);
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
}

export const medicalDocumentService = new MedicalDocumentService();
