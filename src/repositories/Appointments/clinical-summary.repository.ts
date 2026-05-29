import { AppDataSource } from "../../config/database.js";
import { Appointment } from "../../models/Appointments/appointment.model.js";
import { ClinicalNote } from "../../models/Appointments/clinical-note.model.js";
import { PatientMedicalRecord } from "../../models/Appointments/patient-medical-record.model.js";
import { MedicalDocument } from "../../models/Appointments/medical-document.model.js";
import { PatientPrescription } from "../../models/Appointments/patient-prescription.model.js";
import { PostVisitDocument } from "../../models/Appointments/post-visit-document.model.js";

export class ClinicalSummaryRepository {
    async getSummaryByAppointment(appointmentId: number) {
        // 1. Get Appointment with basic info
        const appointmentRepo = AppDataSource.getRepository(Appointment);
        const appointment = await appointmentRepo.findOne({
            where: { Id: appointmentId },
            relations: ["User", "Doctor", "Hospital"]
        });

        if (!appointment) return null;

        // 2. Get Clinical Notes
        const notesRepo = AppDataSource.getRepository(ClinicalNote);
        const clinicalNotes = await notesRepo.find({
            where: { AppointmentId: appointmentId }
        });

        // 3. Get Medical Records (Diagnosis, Vitals, Treatment)
        const medicalRecordRepo = AppDataSource.getRepository(PatientMedicalRecord);
        const medicalRecords = await medicalRecordRepo.find({
            where: { AppointmentId: appointmentId },
            relations: ["Doctor"]
        });

        // 4. Get Medical Documents (uploaded files for this appointment)
        const documentRepo = AppDataSource.getRepository(MedicalDocument);
        const documents = await documentRepo.find({
            where: { AppointmentId: appointmentId, IsDeleted: false },
            relations: ["UploadedByUser"],
            order: { CreatedAt: "DESC" }
        });

        // 5. Get Structured Prescriptions with full relations
        const prescriptionRepo = AppDataSource.getRepository(PatientPrescription);
        const prescriptions = await prescriptionRepo.find({
            where: { AppointmentId: String(appointmentId) },
            relations: ["Diagnoses", "Medications", "Medications.Schedules", "Medications.Days"]
        });

        // 6. Get Post-Visit Generated Documents (Reports sent to patient)
        const postVisitDocRepo = AppDataSource.getRepository(PostVisitDocument);
        const postVisitDocuments = await postVisitDocRepo.find({
            where: { AppointmentId: appointmentId, IsDeleted: false }
        });

        return {
            appointment,
            clinicalNotes,
            medicalRecords,
            documents,
            prescriptions,
            postVisitDocuments
        };
    }
}

export const clinicalSummaryRepository = new ClinicalSummaryRepository();
