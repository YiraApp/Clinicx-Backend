import { patientVerificationRepository } from "../../repositories/Appointments/patient-verification.repository.js";
import { patientVerificationDocumentRepository } from "../../repositories/Appointments/patient-verification-document.repository.js";
import { appointmentRepository } from "../../repositories/Appointments/appointment.repository.js";
import { patientQueueRepository } from "../../repositories/Appointments/patient-queue.repository.js";
import { PatientVerification } from "../../models/Appointments/patient-verification.model.js";
import { PatientVerificationDocument } from "../../models/Appointments/patient-verification-document.model.js";
import { blobService } from "../../services/Common/blob.service.js";
import { appointmentService } from "./appointment.service.js";
import { AppointmentStatus } from "../../enums/appointments.js";

export const VerificationDocumentTypes = {
    ID_PROOF: "ID_PROOF",
    PATIENT_PHOTO: "PATIENT_PHOTO",
    INSURANCE: "INSURANCE"
};

export class VerificationService {
    async uploadDocument(appointmentId: number, type: string, file: Express.Multer.File, userId?: string): Promise<PatientVerificationDocument> {
        // 1. Upload to Azure Blob Storage using the existing BlobService
        const uploadResult = await blobService.uploadFiles([file], userId || "anonymous", "verifications");
        const fileUrl = uploadResult[0].fileUrl;

        // 2. Save or Update the document record with the Azure URL
        const doc = await patientVerificationDocumentRepository.upsert(appointmentId, type, {
            FileUrl: fileUrl,
            UploadedAt: new Date(),
            CreatedBy: userId,
            UpdatedBy: userId
        });

        return doc;
    }

    async getVerificationStatus(appointmentId: number): Promise<{
        status: PatientVerification | null;
        documents: PatientVerificationDocument[];
    }> {
        const status = await patientVerificationRepository.findByAppointmentId(appointmentId);
        const documents = await patientVerificationDocumentRepository.findByAppointmentId(appointmentId);
        
        return { status, documents };
    }

    async updateMasterStatus(appointmentId: number, data: Partial<PatientVerification>): Promise<void> {
        await patientVerificationRepository.upsert(appointmentId, data);
    }

    async completeCheckin(appointmentId: number, data: { 
        notes?: string;
        insuranceId?: string;
        isIdVerified?: boolean;
        isDocumentVerified?: boolean;
        isInsuranceVerified?: boolean;
        verifiedBy?: string;
    }): Promise<void> {
        // 1. Get Appointment details to get DoctorId
        const appointment = await appointmentRepository.findById(appointmentId);
        if (!appointment) throw new Error("Appointment not found");

        // 2. Update Verification Master Record with all flags
        await patientVerificationRepository.upsert(appointmentId, {
            CheckInStatus: "Verified",
            IsIdVerified: data.isIdVerified,
            IsDocumentVerified: data.isDocumentVerified,
            IsInsuranceVerified: data.isInsuranceVerified,
            InsuranceId: data.insuranceId,
            Notes: data.notes,
            VerifiedAt: new Date(),
            VerifiedBy: data.verifiedBy,
            UpdatedBy: data.verifiedBy
        });

        // 3. Update Appointment Status to "Arrived" using the central service
        // This will automatically handle the patient queue logic
        await appointmentService.updateAppointmentStatus(appointmentId, AppointmentStatus.Arrived);
    }
}

export const verificationService = new VerificationService();
