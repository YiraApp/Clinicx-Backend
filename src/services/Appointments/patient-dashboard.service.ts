import { AppDataSource } from "../../config/database.js";
import { User } from "../../models/Account/user.model.js";
import { Appointment } from "../../models/Appointments/appointment.model.js";
import { PatientMedicalRecord } from "../../models/Appointments/patient-medical-record.model.js";
import { HealthcareProvider } from "../../models/Organizations/healthcare-provider.model.js";
import { PatientPrescription } from "../../models/Appointments/patient-prescription.model.js";
import { AppointmentBill } from "../../models/Payments/appointment-bill.model.js";
import { MoreThanOrEqual } from "typeorm/index.js";

export class PatientDashboardService {
    async getPatientDashboardDetails(userId: string) {
        // 1. Get user details
        const user = await AppDataSource.getRepository(User).findOne({
            where: { Id: userId, IsDeleted: false }
        });
        if (!user) return null;

        // 2. Fetch upcoming appointments
        const todayStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
        const upcomingApptsRaw = await AppDataSource.getRepository(Appointment).find({
            where: { UserId: userId, Status: "scheduled", AppointmentDate: MoreThanOrEqual(todayStr as any) },
            relations: ["Doctor"],
            order: { AppointmentDate: "ASC", StartTime: "ASC" },
            take: 5
        });

        const upcomingAppointments = [];
        for (const appt of upcomingApptsRaw) {
            let specialty = "General Medicine";
            if (appt.DoctorId) {
                const provider = await AppDataSource.getRepository(HealthcareProvider).findOne({
                    where: { UserId: appt.DoctorId, IsDeleted: false }
                });
                if (provider) {
                    specialty = provider.Specialty;
                }
            }
            upcomingAppointments.push({
                id: appt.Id,
                doctor: appt.Doctor ? `Dr. ${appt.Doctor.FirstName || ""} ${appt.Doctor.LastName || ""}`.trim() : "Unknown Doctor",
                specialty,
                date: appt.AppointmentDate,
                time: appt.StartTime,
                type: appt.IsTeleConsultation ? "Video" : (appt.AppointmentType || "In-Person"),
                status: appt.Status
            });
        }

        // 3. Fetch recent appointments
        const recentApptsRaw = await AppDataSource.getRepository(Appointment).find({
            where: { UserId: userId },
            relations: ["Doctor"],
            order: { AppointmentDate: "DESC", StartTime: "DESC" },
            take: 5
        });

        const recentAppointments = [];
        for (const appt of recentApptsRaw) {
            const isUpcoming = new Date(appt.AppointmentDate) >= new Date(todayStr);
            if (isUpcoming && appt.Status === "scheduled") {
                continue; // skip since it's already in upcoming
            }
            let specialty = "General Medicine";
            if (appt.DoctorId) {
                const provider = await AppDataSource.getRepository(HealthcareProvider).findOne({
                    where: { UserId: appt.DoctorId, IsDeleted: false }
                });
                if (provider) {
                    specialty = provider.Specialty;
                }
            }
            recentAppointments.push({
                id: appt.Id,
                doctor: appt.Doctor ? `Dr. ${appt.Doctor.FirstName || ""} ${appt.Doctor.LastName || ""}`.trim() : "Unknown Doctor",
                specialty,
                date: appt.AppointmentDate,
                time: appt.StartTime,
                type: appt.IsTeleConsultation ? "Video" : (appt.AppointmentType || "In-Person"),
                status: appt.Status
            });
        }

        // 4. Fetch recent vitals signs from patient medical records
        const latestRecord = await AppDataSource.getRepository(PatientMedicalRecord).findOne({
            where: { PatientId: userId },
            order: { CreatedAt: "DESC", Date: "DESC" }
        });

        const vitals = [
            { label: "BP", value: latestRecord?.BloodPressure || "--", unit: "mmHg", trend: "stable", icon: "Heart", color: "text-rose-500", bg: "bg-rose-50" },
            { label: "Temp", value: latestRecord?.Temperature || "--", unit: "°F", trend: "stable", icon: "Activity", color: "text-amber-500", bg: "bg-amber-50" },
            { label: "Weight", value: latestRecord?.Weight || "--", unit: "kg", trend: "stable", icon: "TrendingUp", color: "text-blue-500", bg: "bg-blue-50" },
            { label: "Height", value: latestRecord?.Height || "--", unit: "cm", trend: "stable", icon: "TrendingUp", color: "text-indigo-500", bg: "bg-indigo-50" }
        ];

        // 5. Fetch prescriptions and check active ones
        const prescriptions = await AppDataSource.getRepository(PatientPrescription).find({
            where: { PatientId: userId },
            relations: ["Medications"],
            order: { CreatedAt: "DESC", Date: "DESC" },
            take: 10
        });

        const recentPrescriptions: any[] = [];
        const now = new Date();

        for (const p of prescriptions) {
            if (!p.Medications) continue;
            const rxDate = p.Date ? new Date(p.Date) : (p.CreatedAt ? new Date(p.CreatedAt) : new Date());

            for (const med of p.Medications) {
                let isActive = true;
                let refillDueStr = "N/A";
                
                let durationVal = med.DurationValue;
                let durationUnit = med.DurationUnit ? med.DurationUnit.toLowerCase().trim() : "";

                // If DurationValue is not set but DurationUnit contains a text duration (e.g. "10 days")
                if (!durationVal && durationUnit) {
                    const match = durationUnit.match(/^(\d+)\s*(.*)$/);
                    if (match) {
                        durationVal = parseInt(match[1], 10);
                        durationUnit = match[2].trim();
                    }
                }

                if (durationVal && durationUnit) {
                    const endDate = new Date(rxDate.getTime());

                    if (durationUnit.includes("day") || durationUnit === "d") {
                        endDate.setDate(endDate.getDate() + durationVal);
                    } else if (durationUnit.includes("week") || durationUnit === "w") {
                        endDate.setDate(endDate.getDate() + (durationVal * 7));
                    } else if (durationUnit.includes("month") || durationUnit === "m") {
                        endDate.setMonth(endDate.getMonth() + durationVal);
                    } else {
                        endDate.setDate(endDate.getDate() + durationVal);
                    }

                    isActive = endDate >= now;
                    refillDueStr = endDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
                }

                if (isActive) {
                    recentPrescriptions.push({
                        name: med.Medication,
                        dosage: med.Dosage || "As directed",
                        refillDue: refillDueStr,
                        status: "active"
                    });
                }
            }
        }

        // 6. Fetch pending actions
        const pendingActions = [];
        
        // Check outstanding bills
        const unpaidBills = await AppDataSource.getRepository(AppointmentBill).find({
            where: { PatientId: userId, IsDeleted: false }
        });

        const totalDue = unpaidBills.reduce((acc, bill) => acc + (Number(bill.DueAmount) || 0), 0);
        if (totalDue > 0) {
            pendingActions.push({
                label: `Pay outstanding bill ₹${totalDue.toFixed(0)}`,
                link: "/patient/billing",
                urgent: false
            });
        }



        return {
            userName: `${user.FirstName || ""} ${user.LastName || ""}`.trim(),
            vitals,
            upcomingAppointments,
            recentAppointments,
            recentPrescriptions: recentPrescriptions.slice(0, 3),
            pendingActions
        };
    }
}

export const patientDashboardService = new PatientDashboardService();
