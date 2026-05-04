import { consentTemplateRepository } from "../../repositories/Consent/consent-template.repository.js";
import { blobService } from "../Common/blob.service.js";
import { ConsentTemplate } from "../../models/Consent/consent-template.model.js";
import { patientConsentRepository } from "../../repositories/Consent/patient-consent.repository.js";
import { appointmentRepository } from "../../repositories/Appointments/appointment.repository.js";
import { smsService } from "../Common/sms.service.js";
import { mailService } from "../Mail/mail.service.js";

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
     * Retrieves a single template by ID.
     */
    async getTemplateById(id: number) {
        return await consentTemplateRepository.getTemplateById(id);
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

    /**
     * Generates a consent request and sends an SMS link to the patient.
     */
    async sendConsent(data: { appointmentId: number, templateId: number, createdBy?: string, channel?: string }) {
        // 1. Get Appointment Details (to find the user)
        const appointment = await appointmentRepository.findById(data.appointmentId);
        if (!appointment) throw new Error("Appointment not found.");
        if (!appointment.User) throw new Error("User details not found for this appointment.");

        // 2. Get Template Details
        const templates = await consentTemplateRepository.getTemplates(appointment.HospitalId, appointment.OrgId);
        const template = templates.find(t => t.Id === data.templateId);
        if (!template) throw new Error("Consent template not found.");

        const channel = data.channel || "SMS";

        // 3. Create Patient Consent record
        const patientConsent = await patientConsentRepository.create({
            AppointmentId: data.appointmentId,
            TemplateId: data.templateId,
            Status: "Pending",
            PdfUrl: template.PdfUrl,
            SentVia: channel,
            SentAt: new Date(),
            CreatedBy: data.createdBy
        });

        // 4. Generate Link
        const signUrl = `https://clinicx.yira.ai/sign-consent/${patientConsent.RequestLink}`;

        // 5. Dispatch based on channel
        const patient = appointment.User;
        if (channel === "Email" && patient.Email) {
            const subject = `Consent Form Signature Required: ${template.Name}`;
            const body = `
                <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                    <h2 style="color: #4f46e5;">ClinicX Consent Signature Request</h2>
                    <p>Hello <strong>${patient.FirstName}</strong>,</p>
                    <p>You have a new consent form to sign for your clinical visit: <strong>"${template.Name}"</strong>.</p>
                    <p>Please click the button below to review and sign the document securely:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${signUrl}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Sign Consent Form</a>
                    </div>
                    <p style="font-size: 12px; color: #666;">If the button doesn't work, copy and paste this link: ${signUrl}</p>
                    <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
                    <p style="font-size: 11px; color: #999;">This is an automated clinical notification from ClinicX.</p>
                </div>
            `;
            await mailService.sendMail({
                to: patient.Email,
                subject,
                body
            });
        } else {
            // Default to SMS (even for WhatsApp for now as we use SMS service)
            const message = `Hello ${patient.FirstName}, please sign the consent form "${template.Name}" for your appointment: ${signUrl} - ClinicX`;
            await smsService.sendSMS(patient.CountryCode + patient.PhoneNumber, message);
        }

        return patientConsent;
    }
}

export const consentService = new ConsentService();
