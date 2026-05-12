import { consentTemplateRepository } from "../../repositories/Consent/consent-template.repository.js";
import { blobService } from "../Common/blob.service.js";
import { ConsentTemplate } from "../../models/Consent/consent-template.model.js";
import { patientConsentRepository } from "../../repositories/Consent/patient-consent.repository.js";
import { appointmentRepository } from "../../repositories/Appointments/appointment.repository.js";
import { smsService } from "../Common/sms.service.js";
import { mailService } from "../Mail/mail.service.js";
import { consentRequestRepository } from "../../repositories/Consent/consent-request.repository.js";
import { PDFDocument, rgb } from "pdf-lib";
import crypto from "crypto";

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
     * Updates an existing template.
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

        if (file && metadata.OrgName && metadata.HospitalName) {
            const cleanOrgName = metadata.OrgName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
            const cleanHospName = metadata.HospitalName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
            const directory = `${cleanOrgName}/${cleanHospName}`;

            const uploadResult = await blobService.uploadFiles([file], directory, "consent-templates");
            if (uploadResult && uploadResult.length > 0) {
                pdfUrl = uploadResult[0].fileUrl;
            }
        }

        const updateData: Partial<ConsentTemplate> = {
            UpdatedBy: metadata.UpdatedBy
        };

        if (metadata.Name !== undefined) updateData.Name = metadata.Name;
        if (metadata.Description !== undefined) updateData.Description = metadata.Description;
        if (metadata.Status !== undefined) updateData.Status = metadata.Status;
        if (metadata.IsDeleted !== undefined) updateData.IsDeleted = metadata.IsDeleted;
        if (pdfUrl) updateData.PdfUrl = pdfUrl;

        let signatureFields = fields;
        if (typeof fields === 'string') {
            try {
                signatureFields = JSON.parse(fields);
            } catch (e) {
                signatureFields = undefined;
            }
        }

        return await consentTemplateRepository.updateTemplate(templateId, updateData, signatureFields);
    }

    /**
     * Gets the status of all consents for a specific date and hospital.
     */
    async getDailyConsentStatus(date: string, hospitalId: number): Promise<any[]> {
        // 1. Fetch all appointments for the date
        const appointments = await appointmentRepository.getAppointments({ date, hospitalId });

        if (appointments.length === 0) return [];

        // 2. Fetch all consent requests for these appointments
        const appointmentIds = appointments.map(a => a.Id);
        const consentRequests = await consentRequestRepository.findByAppointmentIds(appointmentIds);

        // 3. Map status
        return appointments.map(app => {
            const requests = consentRequests.filter(r => r.AppointmentId === app.Id);

            let status = "Not Sent";
            if (requests.length > 0) {
                const anyPending = requests.some(r => r.Status === "Pending");
                const anySigned = requests.some(r => r.Status === "Signed");

                if (anyPending) {
                    status = "Pending";
                } else if (anySigned) {
                    status = "Signed";
                }
            }

            return {
                AppointmentId: app.Id,
                PatientId: app.UserId,
                PatientName: `${app.User?.FirstName} ${app.User?.LastName || ""}`.trim(),
                DoctorName: app.Doctor?.FirstName ? `Dr. ${app.Doctor.FirstName} ${app.Doctor.LastName || ""}`.trim() : "N/A",
                AppointmentTime: app.StartTime,
                Status: status,
                RequestLink: requests.length > 0 ? requests[0].RequestLink : null,
                DocumentCount: requests.length,
                SignedCount: requests.filter(r => r.Status === "Signed").length
            };
        });
    }

    /**
     * Gets the status of all consents for a specific appointment.
     */
    async getAppointmentConsentStatus(appointmentId: number) {
        return await patientConsentRepository.findByAppointment(appointmentId);
    }

    /**
     * Generates a consent request and sends a link.
     */
    async sendConsent(data: { appointmentId: number, templateIds: number[], createdBy?: string, channel?: string }) {
        const appointment = await appointmentRepository.findById(data.appointmentId);
        if (!appointment) throw new Error("Appointment not found.");
        if (!appointment.User) throw new Error("User details not found.");

        const templates = await consentTemplateRepository.getTemplates(appointment.HospitalId, appointment.OrgId);

        const channel = data.channel || "SMS";
        let batchLink = crypto.randomUUID();
        let validTemplates = [];

        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24);

        for (const tid of data.templateIds) {
            const template = templates.find(t => t.TemplateId === tid);
            if (!template) continue;
            validTemplates.push(template.Name);

            await patientConsentRepository.create({
                AppointmentId: data.appointmentId,
                TemplateId: tid,
                Status: "Pending",
                PdfUrl: template.PdfUrl,
                SentVia: channel,
                SentAt: new Date(),
                CreatedBy: data.createdBy
            });

            await consentRequestRepository.create({
                PatientId: appointment.UserId,
                AppointmentId: data.appointmentId,
                TemplateId: tid,
                HospitalId: appointment.HospitalId,
                OrganizationId: appointment.OrgId,
                Status: "Pending",
                RequestLink: batchLink,
                ExpiresAt: expiresAt
            });
        }

        if (validTemplates.length === 0) {
            throw new Error("No valid templates found.");
        }

        const baseUrl = process.env.FRONTEND_URL || process.env.CLIENT_URL || "http://localhost:4200";
        const cleanBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
        const signUrl = `${cleanBaseUrl}/sign-consent/${batchLink}`;

        const patient = appointment.User;
        const templateNames = validTemplates.join(", ");

        if (channel === "Email" && patient.Email) {
            await mailService.sendDynamicEmail("CONSENT_EMAIL", patient.Email, {
                PatientName: `${patient.FirstName} ${patient.LastName || ""}`.trim(),
                HospitalName: appointment.Hospital?.Name || "the facility",
                ConsentLink: signUrl
            });
        } else {
            const phone = patient.CountryCode + patient.PhoneNumber;
            await smsService.sendDynamicSMS("CONSENT_SMS", phone, {
                PatientName: `${patient.FirstName} ${patient.LastName || ""}`.trim(),
                HospitalName: appointment.Hospital?.Name || "the facility",
                ConsentLink: signUrl
            });
        }

        return { batchLink, SignUrl: signUrl };
    }

    /**
     * Fetches all consent requests for a batch link.
     */
    async getConsentRequestByLink(link: string) {
        return await consentRequestRepository.findManyByLink(link);
    }

    /**
     * Updates consent requests with signature and stamps the PDFs for the entire batch.
     */
    async submitConsentSignature(link: string, signatureData: string, ipAddress: string) {
        const requests = await consentRequestRepository.findManyByLink(link);

        if (!requests || requests.length === 0) throw new Error("Consent requests not found.");

        // Use the first request's patient as they are all for the same patient in a batch
        const firstRequest = requests[0];
        const patientName = `${firstRequest.Patient?.FirstName} ${firstRequest.Patient?.LastName || ""}`.trim();
        const signedAt = new Date();
        const base64Data = signatureData.split(",")[1] || signatureData;
        const signatureBuffer = Buffer.from(base64Data, "base64");

        // Upload the signature image ONCE for the batch
        const cleanHospitalName = (firstRequest.Hospital?.Name || "Hospital").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
        const timestamp = Date.now();
        const sigFileName = `signature_batch_${link}_${timestamp}.png`;
        const sigBlobPath = `${cleanHospitalName}/signatures/${sigFileName}`;
        const signatureImageUrl = await blobService.uploadBuffer(signatureBuffer, sigBlobPath, "image/png");

        for (const request of requests) {
            if (request.Status === "Signed") continue; // Skip already signed

            let signedPdfUrl = "";

            if (request.Template?.PdfUrl) {
                try {
                    console.log(`[Consent Service] Stamping signature onto PDF: ${request.Template.PdfUrl}`);
                    const pdfBuffer = await blobService.downloadFile(request.Template.PdfUrl);
                    const pdfDoc = await PDFDocument.load(pdfBuffer);

                    const signatureImage = await pdfDoc.embedPng(signatureBuffer);

                    // C. Draw Signature based on Predefined Fields or Default
                    const pages = pdfDoc.getPages();
                    const fields = request.Template?.SignatureFields || [];

                    if (fields.length > 0) {
                        for (const field of fields) {
                            const page = pages[field.PageNumber - 1] || pages[pages.length - 1];
                            const { width: pWidth, height: pHeight } = page.getSize();

                            const drawX = field.X - (field.Width / 2);
                            const drawY = pHeight - (field.Y + (field.Height / 2));

                            page.drawImage(signatureImage, {
                                x: drawX,
                                y: drawY,
                                width: field.Width,
                                height: field.Height,
                            });

                            if (field.IncludeSignerName) {
                                page.drawText(patientName, {
                                    x: drawX,
                                    y: drawY - 12,
                                    size: 10,
                                    color: rgb(0.1, 0.1, 0.1),
                                });
                            }
                        }
                    } else {
                        // Default Fallback
                        const lastPage = pages[pages.length - 1];
                        const { width } = lastPage.getSize();
                        const sigWidth = 150;
                        const sigHeight = (signatureImage.height / signatureImage.width) * sigWidth;

                        lastPage.drawImage(signatureImage, {
                            x: width - sigWidth - 50,
                            y: 70,
                            width: sigWidth,
                            height: sigHeight,
                        });

                        lastPage.drawText(patientName, {
                            x: width - sigWidth - 50,
                            y: 55,
                            size: 10,
                            color: rgb(0.1, 0.1, 0.1),
                        });
                    }

                    const modifiedPdfBuffer = Buffer.from(await pdfDoc.save());
                    const pdfFileName = `signed_consent_${request.Id}_${timestamp}.pdf`;
                    const pdfBlobPath = `${cleanHospitalName}/signed-consents/${pdfFileName}`;

                    signedPdfUrl = await blobService.uploadBuffer(modifiedPdfBuffer, pdfBlobPath, "application/pdf");

                    request.SignedPdfUrl = signedPdfUrl;

                    // Sync with PatientConsent (Clinical Record)
                    if (request.AppointmentId) {
                        const patientConsents = await patientConsentRepository.findByAppointment(request.AppointmentId);
                        const matchingConsent = patientConsents.find(c => c.TemplateId === request.TemplateId && c.Status === "Pending");

                        if (matchingConsent) {
                            await patientConsentRepository.updateStatus(matchingConsent.Id, "Signed", signedPdfUrl);
                        }
                    }
                } catch (pdfError: any) {
                    console.error(`[Consent Service] PDF Stamping failed for Template ${request.TemplateId}:`, pdfError.message);
                    throw pdfError;
                }
            }

            request.Status = "Signed";
            request.Signature = signatureImageUrl; // Use Blob URL instead of Base64
            request.SignatureImageUrl = signatureImageUrl;
            request.IpAddress = ipAddress;
            request.SignedAt = signedAt;
            request.UpdatedAt = signedAt;

            await consentRequestRepository.save(request);
        }

        // Return the first request to maintain API signature or the whole array if needed
        const updatedRequests = await consentRequestRepository.findManyByLink(link);

        return updatedRequests[0];
    }
}

export const consentService = new ConsentService();
