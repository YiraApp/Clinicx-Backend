import { consentTemplateRepository } from "../../repositories/Consent/consent-template.repository.js";
import { blobService } from "../Common/blob.service.js";
import { ConsentTemplate } from "../../models/Consent/consent-template.model.js";

export class ConsentService {
    /**
     * Uploads the PDF to Azure and saves the template to the database.
     */
    async createTemplate(
        file: Express.Multer.File,
        metadata: {
            Name: string;
            HospitalId: number;
            OrganizationId: number;
            HospitalName: string;
            OrgName: string;
            Description?: string;
            CreatedBy?: string;
        },
        fields: any[] = []
    ): Promise<ConsentTemplate> {
        // 1. Upload PDF to Azure
        // Clean up the names to be safe for URLs (remove spaces and special characters)
        const cleanOrgName = metadata.OrgName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
        const cleanHospName = metadata.HospitalName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
        const directory = `${cleanOrgName}/${cleanHospName}`;
        
        const uploadResult = await blobService.uploadFiles([file], directory, "consent-templates");

        if (!uploadResult || uploadResult.length === 0) {
            throw new Error("Failed to upload PDF to Azure Storage");
        }

        const pdfUrl = uploadResult[0].fileUrl;

        // 2. Save Template to Database
        const templateData: Partial<ConsentTemplate> = {
            Name: metadata.Name,
            Description: metadata.Description,
            HospitalId: metadata.HospitalId,
            OrganizationId: metadata.OrganizationId,
            PdfUrl: pdfUrl,
            Status: true,
            IsDeleted: false,
            CreatedBy: metadata.CreatedBy,
            Version: 1
        };

        // If fields are provided as a JSON string, parse them
        let signatureFields = fields;
        if (typeof fields === 'string') {
            try {
                signatureFields = JSON.parse(fields);
            } catch (e) {
                console.warn("Failed to parse signature fields, using empty array");
                signatureFields = [];
            }
        }

        return await consentTemplateRepository.createTemplate(templateData, signatureFields);
    }

    /**
     * Retrieves all templates for a hospital or organization.
     */
    async getTemplates(hospitalId?: number, organizationId?: number) {
        return await consentTemplateRepository.getTemplates(hospitalId, organizationId);
    }

    /**
     * Updates an existing template. Handles optional PDF replacement and updates fields.
     */
    async updateTemplate(
        templateId: number,
        file: Express.Multer.File | undefined,
        metadata: {
            Name?: string;
            HospitalName?: string;
            OrgName?: string;
            Description?: string;
            Status?: boolean;
            IsDeleted?: boolean;
            UpdatedBy?: string;
        },
        fields?: any[]
    ): Promise<ConsentTemplate | null> {
        
        let pdfUrl: string | undefined = undefined;

        // 1. Re-upload PDF to Azure if a new one is provided
        if (file && metadata.OrgName && metadata.HospitalName) {
            const cleanOrgName = metadata.OrgName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
            const cleanHospName = metadata.HospitalName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
            const directory = `${cleanOrgName}/${cleanHospName}`;
            
            const uploadResult = await blobService.uploadFiles([file], directory, "consent-templates");
            if (uploadResult && uploadResult.length > 0) {
                pdfUrl = uploadResult[0].fileUrl;
            }
        }

        // 2. Prepare Update Data
        const updateData: Partial<ConsentTemplate> = {
            UpdatedBy: metadata.UpdatedBy
        };

        if (metadata.Name !== undefined) updateData.Name = metadata.Name;
        if (metadata.Description !== undefined) updateData.Description = metadata.Description;
        if (metadata.Status !== undefined) updateData.Status = metadata.Status;
        if (metadata.IsDeleted !== undefined) updateData.IsDeleted = metadata.IsDeleted;
        if (pdfUrl) updateData.PdfUrl = pdfUrl; // Only update if new URL was generated

        // 3. Handle signature fields
        let signatureFields = fields;
        if (typeof fields === 'string') {
            try {
                signatureFields = JSON.parse(fields);
            } catch (e) {
                console.warn("Failed to parse signature fields, ignoring update for fields");
                signatureFields = undefined;
            }
        }

        // 4. Send to Repository
        return await consentTemplateRepository.updateTemplate(templateId, updateData, signatureFields);
    }
}

export const consentService = new ConsentService();
