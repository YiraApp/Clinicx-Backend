import { blobService } from "../Common/blob.service.js";
import { postVisitDocumentRepository } from "../../repositories/Appointments/post-visit-document.repository.js";
import { appointmentShareLinkRepository } from "../../repositories/Appointments/appointment-share-link.repository.js";
import { appointmentRepository } from "../../repositories/Appointments/appointment.repository.js";
import { mailService } from "../Mail/mail.service.js";
import { v4 as uuidv4 } from "uuid";
import { PostVisitDocument } from "../../models/Appointments/post-visit-document.model.js";

export class PostVisitService {
    /**
     * Process clinical documents generated in frontend:
     * 1. Upload to Azure Blob Storage
     * 2. Track each in PostVisitDocuments table
     * 3. Generate a secure unified share link
     * 4. Link documents to the share link
     */
    async processDocuments(appointmentId: number, files: Express.Multer.File[], channel?: string) {
        const appointment = await appointmentRepository.findById(appointmentId);
        if (!appointment) throw new Error("Appointment not found");

        // 1. Upload files and create/update document records
        const documentRecords: PostVisitDocument[] = [];
        for (const file of files) {
            // Generate a folder-based path: hospital/appointment/filename
            const blobPath = `post-visit/${appointment.HospitalId}/${appointmentId}/${file.originalname}`;
            const blobUrl = await blobService.uploadBuffer(file.buffer, blobPath, file.mimetype);

            // Check if document already exists for this appointment and filename
            let doc = await postVisitDocumentRepository.findOne({
                AppointmentId: appointmentId,
                FileName: file.originalname,
                IsDeleted: false
            });

            if (doc) {
                // Update existing record with new delivery flags, latest timestamp, and incremented counts
                await postVisitDocumentRepository.update(doc.Id, {
                    BlobUrl: blobUrl, // Update URL in case it changed
                    GeneratedAt: new Date(),
                    SentOnWhatsApp: doc.SentOnWhatsApp || channel === 'whatsapp',
                    SentOnSMS: doc.SentOnSMS || channel === 'sms',
                    SentOnEmail: doc.SentOnEmail || channel === 'email',
                    WhatsAppSentAt: channel === 'whatsapp' ? new Date() : doc.WhatsAppSentAt,
                    SmsSentAt: channel === 'sms' ? new Date() : doc.SmsSentAt,
                    EmailSentAt: channel === 'email' ? new Date() : doc.EmailSentAt,
                    WhatsAppSentTo: channel === 'whatsapp' ? appointment.User.PhoneNumber : doc.WhatsAppSentTo,
                    SmsSentTo: channel === 'sms' ? appointment.User.PhoneNumber : doc.SmsSentTo,
                    EmailSentTo: (channel === 'email' ? appointment.User.Email : doc.EmailSentTo) ?? undefined,
                    WhatsAppSentCount: (doc.WhatsAppSentCount || 0) + (channel === 'whatsapp' ? 1 : 0),
                    SmsSentCount: (doc.SmsSentCount || 0) + (channel === 'sms' ? 1 : 0),
                    EmailSentCount: (doc.EmailSentCount || 0) + (channel === 'email' ? 1 : 0),
                });
                const updated = await postVisitDocumentRepository.findById(doc.Id);
                if (updated) doc = updated;
            } else {
                // Create new document record
                doc = await postVisitDocumentRepository.create({
                    AppointmentId: appointmentId,
                    PatientId: appointment.UserId,
                    DoctorId: appointment.DoctorId,
                    OrganizationId: appointment.OrgId,
                    HospitalId: appointment.HospitalId,
                    DocumentType: this.getDocumentTypeFromFileName(file.originalname),
                    FileName: file.originalname,
                    BlobUrl: blobUrl,
                    FileSize: file.size,
                    MimeType: file.mimetype,
                    GeneratedAt: new Date(),
                    SentOnWhatsApp: channel === 'whatsapp',
                    SentOnSMS: channel === 'sms',
                    SentOnEmail: channel === 'email',
                    WhatsAppSentAt: channel === 'whatsapp' ? new Date() : undefined,
                    SmsSentAt: channel === 'sms' ? new Date() : undefined,
                    EmailSentAt: channel === 'email' ? new Date() : undefined,
                    WhatsAppSentTo: channel === 'whatsapp' ? appointment.User.PhoneNumber : undefined,
                    SmsSentTo: channel === 'sms' ? appointment.User.PhoneNumber : undefined,
                    EmailSentTo: (channel === 'email' ? appointment.User.Email : undefined) ?? undefined,
                    WhatsAppSentCount: channel === 'whatsapp' ? 1 : 0,
                    SmsSentCount: channel === 'sms' ? 1 : 0,
                    EmailSentCount: channel === 'email' ? 1 : 0,
                    Status: "ACTIVE"
                });
            }
            documentRecords.push(doc);
        }

        // 2. Create a secure Share Link for this visit summary
        const shareToken = uuidv4();
        const baseUrl = process.env.FRONTEND_URL || process.env.CLIENT_URL || "http://localhost:5173";
        const cleanBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
        const shareLinkUrl = `${cleanBaseUrl}/view-summary/${shareToken}`;

        const shareLink = await appointmentShareLinkRepository.create({
            AppointmentId: appointmentId,
            PatientId: appointment.UserId,
            OrganizationId: appointment.OrgId,
            HospitalId: appointment.HospitalId,
            ShareToken: shareToken,
            ShareLink: shareLinkUrl,
            ExpiryAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days validity
            IsActive: true,
            CreatedBy: "SYSTEM"
        });

        // 3. Update all documents with the ShareLinkId
        for (const doc of documentRecords) {
            await postVisitDocumentRepository.update(doc.Id, { ShareLinkId: shareLink.Id });
        }

        // 4. Send via selected channel
        if (channel === "email" && appointment.User?.Email) {
            try {
                const templateData = {
                    PatientName: `${appointment.User.FirstName} ${appointment.User.LastName || ""}`.trim(),
                    HospitalName: appointment.Hospital?.Name || "the facility",
                    AppointmentNumber: appointment.AppointmentNumber || appointment.Id,
                    DoctorName: appointment.Doctor ? `${appointment.Doctor.FirstName} ${appointment.Doctor.LastName || ""}`.trim() : "N/A",
                    VisitDate: new Date(appointment.AppointmentDate).toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric"
                    }),
                    ShareLink: shareLinkUrl
                };

                await mailService.sendDynamicEmail("POST_VISIT_MEDICAL_RECORDS", appointment.User.Email, templateData);
            } catch (err) {
                console.error("[PostVisitService] Mail error:", err);
            }
        } else if (channel === "whatsapp" && appointment.User?.PhoneNumber) {
            try {
                const { whatsappService } = await import("../Common/whatsapp.service.js");
                const countryCode = appointment.User.CountryCode || "91";
                const phone = appointment.User.PhoneNumber;
                const normalizedPhone = `${countryCode.replace(/\D/g, "")}${phone.replace(/\D/g, "")}`;
                const patientName = `${appointment.User.FirstName} ${appointment.User.LastName || ""}`.trim();
                const hospitalName = appointment.Hospital?.Name || "our hospital";

                // Template: medical_patient_documents
                // Header: Expected 1 parameter (Hospital Name)
                // Body parameters:
                // {{1}}: Patient Name
                // {{2}}: Hospital Name
                // Button index 0: Dynamic URL token parameter
                const components = [
                    {
                        type: "header",
                        parameters: [
                            { type: "text", text: hospitalName }
                        ]
                    },
                    {
                        type: "body",
                        parameters: [
                            { type: "text", text: patientName },
                            { type: "text", text: hospitalName }
                        ]
                    },
                    {
                        type: "button",
                        sub_type: "url",
                        index: 0,
                        parameters: [
                            { type: "text", text: shareToken }
                        ]
                    }
                ];

                await whatsappService.sendTemplateMessage(normalizedPhone, "medical_patient_documents", "en", components);
                console.log(`[PostVisitService] WhatsApp template sent to ${normalizedPhone}`);
            } catch (err) {
                console.error("[PostVisitService] WhatsApp error:", err);
                throw err;
            }
        } else if (channel === "sms" && appointment.User?.PhoneNumber) {
            try {
                const { smsService } = await import("../Common/sms.service.js");
                const countryCode = appointment.User.CountryCode || "91";
                const phone = appointment.User.PhoneNumber;
                const normalizedPhone = `${countryCode.replace(/\D/g, "")}${phone.replace(/\D/g, "")}`;
                const patientName = `${appointment.User.FirstName} ${appointment.User.LastName || ""}`.trim();
                const hospitalName = appointment.Hospital?.Name || "our hospital";

                const message = `Hello ${patientName}, your medical documents from ${hospitalName} are now available. You can securely view and download them using this link: ${shareLinkUrl} - Thank you`;
                await smsService.sendSMS(normalizedPhone, message);
                console.log(`[PostVisitService] SMS sent to ${normalizedPhone}`);
            } catch (err) {
                console.error("[PostVisitService] SMS error:", err);
                throw err;
            }
        }

        return {
            success: true,
            shareToken: shareLink.ShareToken,
            shareLink: shareLink.ShareLink,
            appointmentId: appointmentId,
            documentCount: documentRecords.length
        };
    }

    /**
     * Retrieve all documents associated with a share token
     */
    async getSharedDocuments(token: string) {
        const shareLink = await appointmentShareLinkRepository.findByToken(token);
        if (!shareLink) throw new Error("Invalid or expired share link");

        const documents = await postVisitDocumentRepository.findByAppointment(Number(shareLink.AppointmentId));
        
        // Filter by ShareLinkId to be extra secure
        return documents.filter(d => Number(d.ShareLinkId) === Number(shareLink.Id));
    }

    private getDocumentTypeFromFileName(fileName: string): string {
        const lower = fileName.toLowerCase();
        if (lower.includes("prescription")) return "PRESCRIPTION";
        if (lower.includes("notes")) return "CLINICAL_NOTES";
        if (lower.includes("medical_record") || lower.includes("records")) return "MEDICAL_RECORD";
        return "SUMMARY";
    }
}

export const postVisitService = new PostVisitService();
