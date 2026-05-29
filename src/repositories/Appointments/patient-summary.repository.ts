import { AppDataSource } from "../../config/database.js";
import { User } from "../../models/Account/user.model.js";
import { Appointment } from "../../models/Appointments/appointment.model.js";
import { PatientMedicalRecord } from "../../models/Appointments/patient-medical-record.model.js";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import { PatientInsurance } from "../../models/Organizations/patient-insurance.model.js";
import { ClinicalNote } from "../../models/Appointments/clinical-note.model.js";

export class PatientSummaryRepository {
    async getPatientSummary(patientId: string, orgId?: number, hospitalId?: number) {
        const user = await AppDataSource.getRepository(User).findOne({
            where: { Id: patientId, IsDeleted: false },
            relations: ["PermanentAddress"]
        });
        if (!user) return null;

        const registration = await AppDataSource.getRepository(PatientRegistration).findOne({
            where: { UserId: patientId, IsDeleted: false }
        });

        const insurance = await AppDataSource.getRepository(PatientInsurance).findOne({
            where: { UserId: patientId, IsDeleted: false }
        });

        const latestAppointment = await AppDataSource.getRepository(Appointment).findOne({
            where: { UserId: patientId },
            relations: ["Doctor"],
            order: { AppointmentDate: "DESC", StartTime: "DESC" }
        });

        let latestVitals = null;
        if (latestAppointment) {
            const latestRecord = await AppDataSource.getRepository(PatientMedicalRecord).findOne({
                where: { PatientId: patientId },
                order: { CreatedAt: "DESC" }
            });
            if (latestRecord) {
                latestVitals = {
                    bloodPressure: latestRecord.BloodPressure,
                    heartRate: latestRecord.HeartRate,
                    temperature: latestRecord.Temperature,
                    weight: latestRecord.Weight,
                    height: latestRecord.Height
                };
            }
        }

        const recentNotes = await AppDataSource.getRepository(ClinicalNote).find({
            where: { PatientId: patientId },
            order: { CreatedAt: "DESC" },
            take: 3,
            relations: ["Doctor"]
        });

        const allergies = registration?.Allergies
            ? registration.Allergies.split(",").map((s: string) => s.trim()).filter(Boolean)
            : [];

        const conditions = registration?.MedicalHistory
            ? registration.MedicalHistory.split(",").map((s: string) => s.trim()).filter(Boolean)
            : [];

        const addr = user.PermanentAddress;
        const address = addr
            ? [addr.AddressLine1, addr.AddressLine2, addr.City, addr.State, addr.Pincode]
                .filter(Boolean)
                .join(", ")
            : "";

        return {
            user: {
                id: user.Id,
                firstName: user.FirstName,
                lastName: user.LastName,
                name: `${user.FirstName || ""} ${user.LastName || ""}`.trim(),
                gender: user.Gender,
                dateOfBirth: user.DateOfBirth,
                age: user.DateOfBirth ? this.calculateAge(user.DateOfBirth) : null,
                phone: user.PhoneNumber,
                email: user.Email,
                bloodGroup: user.BloodGroup,
                address,
                emergencyContactName: user.EmergencyContactName,
                emergencyContactPhone: user.EmergencyContactPhone
            },
            allergies,
            conditions,
            insurance: insurance
                ? {
                    provider: insurance.InsuranceProvider,
                    policyNumber: insurance.InsuranceNumber
                }
                : null,
            latestAppointment: latestAppointment
                ? {
                    id: latestAppointment.Id,
                    appointmentDate: latestAppointment.AppointmentDate,
                    startTime: latestAppointment.StartTime,
                    endTime: latestAppointment.EndTime,
                    status: latestAppointment.Status,
                    type: latestAppointment.AppointmentType,
                    reason: latestAppointment.Reason,
                    doctorName: latestAppointment.Doctor
                        ? `Dr. ${latestAppointment.Doctor.FirstName} ${latestAppointment.Doctor.LastName}`
                        : null
                }
                : null,
            latestVitals,
            recentNotes: recentNotes.map((n) => ({
                id: n.Id,
                content: n.Notes,
                timestamp: n.CreatedAt,
                doctorName: n.Doctor
                    ? `Dr. ${n.Doctor.FirstName} ${n.Doctor.LastName}`
                    : ""
            }))
        };
    }

    private calculateAge(dob: string): number {
        const birth = new Date(dob);
        const today = new Date();
        let age = today.getFullYear() - birth.getFullYear();
        const m = today.getMonth() - birth.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
        return age;
    }
}

export const patientSummaryRepository = new PatientSummaryRepository();
