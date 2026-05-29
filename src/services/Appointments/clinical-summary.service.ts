import { clinicalSummaryRepository } from "../../repositories/Appointments/clinical-summary.repository.js";
import { appointmentShareLinkRepository } from "../../repositories/Appointments/appointment-share-link.repository.js";
import { postVisitDocumentRepository } from "../../repositories/Appointments/post-visit-document.repository.js";
import { mailService } from "../../services/Mail/mail.service.js";
import { v4 as uuidv4 } from "uuid";

export class ClinicalSummaryService {
    async getSummary(appointmentId: number) {
        const summary = await clinicalSummaryRepository.getSummaryByAppointment(appointmentId);
        if (!summary) {
            throw new Error("Appointment not found or has no clinical data.");
        }
        return summary;
    }

    async shareSummary(data: {
        appointmentId: number;
        patientId: string;
        email?: string;
        phone?: string;
        channels: { email?: boolean; whatsapp?: boolean; sms?: boolean };
        createdBy: string;
    }) {
        // 1. Get Summary to ensure it exists and get details
        const summary = await this.getSummary(data.appointmentId);
        
        // 2. Generate Share Token and Link
        const shareToken = uuidv4();
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + 30); // 30 days expiry as per template
        
        const shareLinkRecord = await appointmentShareLinkRepository.create({
            AppointmentId: data.appointmentId,
            PatientId: data.patientId,
            OrganizationId: summary.appointment.OrgId,
            HospitalId: summary.appointment.HospitalId,
            ShareToken: shareToken,
            ExpiryAt: expiry,
            CreatedBy: data.createdBy,
            IsActive: true
        });

        const baseUrl = process.env.PATIENT_PORTAL_URL || "https://patient.clinicx.ai";
        const shareLink = `${baseUrl}/view-records?token=${shareToken}`;

        // 3. Build document list for email (all uploaded documents for this appointment)
        const documentLinks = (summary.documents || []).map((doc: any) => ({
            name: doc.OriginalFileName || doc.FileName,
            url: doc.BlobUrl,
            category: doc.DocumentCategory,
            type: doc.DocumentType
        }));

        // 4. Send Email if requested
        if (data.channels.email && data.email) {
            const templateData = {
                PatientName: `${summary.appointment.User.FirstName} ${summary.appointment.User.LastName}`,
                HospitalName: summary.appointment.Hospital.Name,
                AppointmentNumber: summary.appointment.AppointmentNumber || summary.appointment.Id,
                DoctorName: `${summary.appointment.Doctor.FirstName} ${summary.appointment.Doctor.LastName}`,
                VisitDate: new Date(summary.appointment.AppointmentDate).toLocaleDateString("en-IN", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric"
                }),
                ShareLink: shareLink,
                ClinicalNotesCount: (summary.clinicalNotes || []).length,
                MedicalRecordsCount: (summary.medicalRecords || []).length,
                PrescriptionsCount: (summary.prescriptions || []).length,
                DocumentsCount: documentLinks.length,
                Documents: documentLinks
            };

            await mailService.sendDynamicEmail("POST_VISIT_MEDICAL_RECORDS", data.email, templateData);
            
            // 5. Log PostVisitDocument for each uploaded document + the summary bundle
            await postVisitDocumentRepository.create({
                AppointmentId: data.appointmentId,
                PatientId: data.patientId,
                OrganizationId: summary.appointment.OrgId,
                HospitalId: summary.appointment.HospitalId,
                DocumentType: "SUMMARY_BUNDLE",
                FileName: `Summary_${data.appointmentId}.pdf`,
                BlobUrl: shareLink,
                SentOnEmail: true,
                EmailSentTo: data.email,
                EmailSentAt: new Date(),
                ShareLinkId: shareLinkRecord.Id,
                CreatedBy: data.createdBy,
                IsPrimaryDocument: true,
                Status: "ACTIVE"
            });

            // Log each individual document as sent
            for (const doc of summary.documents || []) {
                await postVisitDocumentRepository.create({
                    AppointmentId: data.appointmentId,
                    PatientId: data.patientId,
                    OrganizationId: summary.appointment.OrgId,
                    HospitalId: summary.appointment.HospitalId,
                    DocumentType: doc.DocumentType || "DOCUMENT",
                    FileName: doc.OriginalFileName || doc.FileName,
                    BlobUrl: doc.BlobUrl,
                    SentOnEmail: true,
                    EmailSentTo: data.email,
                    EmailSentAt: new Date(),
                    ShareLinkId: shareLinkRecord.Id,
                    CreatedBy: data.createdBy,
                    IsPrimaryDocument: false,
                    Status: "ACTIVE"
                });
            }
        }
        
        return {
            success: true,
            shareLink,
            summary: {
                clinicalNotesCount: (summary.clinicalNotes || []).length,
                medicalRecordsCount: (summary.medicalRecords || []).length,
                prescriptionsCount: (summary.prescriptions || []).length,
                documentsCount: documentLinks.length
            }
        };
    }
}

export const clinicalSummaryService = new ClinicalSummaryService();
