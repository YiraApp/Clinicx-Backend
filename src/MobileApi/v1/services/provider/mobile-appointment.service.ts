import { AppDataSource } from "../../../../config/database.js";
import { Appointment } from "../../../../models/Appointments/appointment.model.js";
import { User } from "../../../../models/Account/user.model.js";
import { UserRole } from "../../../../models/Account/userrole.model.js";
import { Role } from "../../../../models/Account/role.model.js";
import { PatientRegistration } from "../../../../models/Organizations/patient-registration.model.js";
import { v4 as uuidv4 } from "uuid";

export class MobileAppointmentService {
    async getAppointmentDashboard(
        doctorId: string,
        hospitalId: number,
        orgId: number,
        options?: { date?: string; dateFrom?: string; dateTo?: string; status?: string; search?: string }
    ): Promise<any> {
        const appointmentRepo = AppDataSource.getRepository(Appointment);

        const todayStr = options?.date || new Date().toISOString().split("T")[0];

        // 1. Calculate stats/counts for today
        const statsQuery = appointmentRepo.createQueryBuilder("apt")
            .select("COUNT(*)", "todayCount")
            .addSelect("COUNT(CASE WHEN LOWER(apt.Status) IN ('confirmed', 'completed', 'scheduled') THEN 1 END)", "confirmedCount")
            .addSelect("COUNT(CASE WHEN LOWER(apt.Status) IN ('pending', 'paymentpending', 'requested') THEN 1 END)", "pendingCount")
            .where("apt.DoctorId = :doctorId", { doctorId });

        if (hospitalId) {
            statsQuery.andWhere("apt.HospitalId = :hospitalId", { hospitalId });
        }
        if (orgId) {
            statsQuery.andWhere("apt.OrgId = :orgId", { orgId });
        }
        statsQuery.andWhere("CAST(apt.AppointmentDate AS DATE) = :todayStr", { todayStr });

        const statsResult = await statsQuery.getRawOne();
        const todayCount = parseInt(statsResult?.todayCount || "0", 10);
        const confirmedCount = parseInt(statsResult?.confirmedCount || "0", 10);
        const pendingCount = parseInt(statsResult?.pendingCount || "0", 10);

        // 2. Fetch appointments list
        const query = appointmentRepo.createQueryBuilder("apt")
            .leftJoinAndSelect("apt.User", "user")
            .where("apt.DoctorId = :doctorId", { doctorId });

        if (hospitalId) {
            query.andWhere("apt.HospitalId = :hospitalId", { hospitalId });
        }
        if (orgId) {
            query.andWhere("apt.OrgId = :orgId", { orgId });
        }

        if (options?.dateFrom && options?.dateTo) {
            query.andWhere("CAST(apt.AppointmentDate AS DATE) >= :dateFrom", { dateFrom: options.dateFrom });
            query.andWhere("CAST(apt.AppointmentDate AS DATE) <= :dateTo", { dateTo: options.dateTo });
        } else if (options?.date) {
            query.andWhere("CAST(apt.AppointmentDate AS DATE) = :dateStr", { dateStr: options.date });
        } else {
            query.andWhere("CAST(apt.AppointmentDate AS DATE) = :todayStr", { todayStr });
        }

        if (options?.status && options.status !== "All Status") {
            query.andWhere("LOWER(apt.Status) = :status", { status: options.status.toLowerCase() });
        }

        if (options?.search && options.search.trim() !== "") {
            const searchPattern = `%${options.search.trim().toLowerCase()}%`;
            query.andWhere("(LOWER(user.FirstName) LIKE :searchPattern OR LOWER(user.LastName) LIKE :searchPattern OR LOWER(user.PhoneNumber) LIKE :searchPattern)", { searchPattern });
        }

        const appointments = await query
            .orderBy("apt.StartTime", "ASC")
            .getMany();

        const formatTime12h = (timeStr: string) => {
            if (!timeStr) return "";
            const parts = timeStr.split(":");
            if (parts.length < 2) return timeStr;
            let hour = parseInt(parts[0], 10);
            const min = parts[1];
            const ampm = hour >= 12 ? "PM" : "AM";
            hour = hour % 12;
            hour = hour ? hour : 12;
            const hourStr = hour < 10 ? `0${hour}` : `${hour}`;
            return `${hourStr}:${min} ${ampm}`;
        };

        const formattedList = appointments.map((apt, index) => {
            const patientName = `${apt.User?.FirstName || ""} ${apt.User?.LastName || ""}`.trim() || "Patient";
            const phone = apt.User?.PhoneNumber || "";
            const formattedTime = formatTime12h(apt.StartTime);
            const durationMins = apt.Duration || 30;

            let normalizedStatus = "scheduled";
            const rawStatus = (apt.Status || "").toLowerCase();
            if (rawStatus.includes("confirm")) normalizedStatus = "confirmed";
            else if (rawStatus.includes("progress")) normalizedStatus = "inProgress";
            else if (rawStatus.includes("complete")) normalizedStatus = "completed";
            else if (rawStatus.includes("pending")) normalizedStatus = "paymentPending";
            else if (rawStatus.includes("cancel")) normalizedStatus = "cancelled";

            return {
                id: String(apt.Id),
                tokenNumber: `Token #${index + 1}`,
                time: formattedTime || apt.StartTime,
                duration: `${durationMins} MIN`,
                patientName,
                phoneNumber: phone,
                type: apt.IsTeleConsultation ? "videoCall" : "inClinic",
                category: apt.AppointmentType || apt.Reason || "Consultation",
                status: normalizedStatus,
                appointmentDate: apt.AppointmentDate,
                meetingUrl: apt.MeetingUrl || null,
                patientUserId: apt.UserId || null,
                orgId: apt.OrgId || null,
                hospitalId: apt.HospitalId || null,
                reason: apt.Reason || ""
            };
        });

        return {
            todayCount,
            confirmedCount,
            pendingCount,
            aiOptimizationScore: 94,
            appointments: formattedList
        };
    }

    async bookAppointment(data: {
        doctorId: string;
        hospitalId: number;
        orgId: number;
        patientName?: string;
        patientPhone: string;
        gender?: string;
        dob?: string;
        appointmentDate: string;
        startTime: string;
        reason?: string;
        appointmentType?: string;
        isTeleConsultation?: boolean;
    }): Promise<any> {
        const userRepo = AppDataSource.getRepository(User);
        const userRoleRepo = AppDataSource.getRepository(UserRole);
        const patientRegRepo = AppDataSource.getRepository(PatientRegistration);
        const appointmentRepo = AppDataSource.getRepository(Appointment);

        const cleanPhone = (data.patientPhone || "").replace(/[^\d]/g, "");
        if (!cleanPhone || cleanPhone.length < 10) {
            throw new Error("Valid patient phone number is required");
        }

        const last10Digits = cleanPhone.slice(-10);

        let patientUser = await userRepo.createQueryBuilder("u")
            .where("u.IsDeleted = 0")
            .andWhere("(u.PhoneNumber = :phone OR u.PhoneNumber LIKE :last10)", {
                phone: cleanPhone,
                last10: `%${last10Digits}`
            })
            .getOne();

        if (!patientUser) {
            patientUser = new User();
            patientUser.Id = uuidv4();
            patientUser.IsPrimary = true;
            patientUser.Relation = "Self";

            const nameParts = (data.patientName || "Mobile Patient").trim().split(" ");
            patientUser.FirstName = nameParts[0];
            patientUser.LastName = nameParts.slice(1).join(" ") || "";
            patientUser.PhoneNumber = cleanPhone;
            if (data.gender) patientUser.Gender = data.gender;
            if (data.dob) (patientUser as any).Dob = new Date(data.dob);
            patientUser.Email = `${last10Digits}@yira.ai`;
            patientUser.Status = true;
            patientUser.IsDeleted = false;
            await userRepo.save(patientUser);
        } else if (data.patientName && (!patientUser.FirstName || patientUser.FirstName === "Mobile" || patientUser.FirstName === "Patient")) {
            const nameParts = data.patientName.trim().split(" ");
            patientUser.FirstName = nameParts[0];
            patientUser.LastName = nameParts.slice(1).join(" ") || "";
            await userRepo.save(patientUser);
        }

        // Ensure UserRole mapping exists for Patient
        const existingRole = await userRoleRepo.findOne({
            where: { UserId: patientUser.Id, OrganizationId: data.orgId, HospitalId: data.hospitalId, IsDeleted: false }
        });

        if (!existingRole) {
            const roleRepo = AppDataSource.getRepository(Role);
            const patientRole = await roleRepo.findOne({ where: { RoleName: "Patient" } });

            const userRole = new UserRole();
            userRole.UserId = patientUser.Id;
            userRole.RoleId = patientRole ? patientRole.Id : "4FC67429-28AE-4106-93EF-436228282ED0";
            userRole.OrganizationId = data.orgId;
            userRole.HospitalId = data.hospitalId;
            userRole.Status = true;
            userRole.IsDeleted = false;
            await userRoleRepo.save(userRole);
        }

        // Ensure PatientRegistration mapping exists
        const existingReg = await patientRegRepo.findOne({
            where: { UserId: patientUser.Id, OrganizationId: data.orgId, HospitalId: data.hospitalId }
        });

        if (!existingReg) {
            const patientReg = new PatientRegistration();
            patientReg.UserId = patientUser.Id;
            patientReg.OrganizationId = data.orgId;
            patientReg.HospitalId = data.hospitalId;
            patientReg.Status = true;
            patientReg.IsDeleted = false;
            await patientRegRepo.save(patientReg);
        }

        // Create & Save Appointment
        const appointment = new Appointment();
        appointment.UserId = patientUser.Id;
        appointment.DoctorId = data.doctorId;
        appointment.OrgId = data.orgId;
        appointment.HospitalId = data.hospitalId;
        appointment.AppointmentDate = new Date(data.appointmentDate);
        appointment.StartTime = data.startTime || "10:00:00";
        appointment.Duration = 30;
        appointment.Reason = data.reason || "General Checkup";
        appointment.AppointmentType = data.appointmentType || (data.isTeleConsultation ? "Video Consultation" : "In-Clinic");
        appointment.IsTeleConsultation = data.isTeleConsultation || false;
        appointment.Status = "Scheduled";
        appointment.CreatedBy = "MobileApp";

        const savedAppointment = await appointmentRepo.save(appointment);

        return {
            appointmentId: savedAppointment.Id,
            patientUserId: patientUser.Id,
            patientName: `${patientUser.FirstName || ""} ${patientUser.LastName || ""}`.trim(),
            appointmentDate: savedAppointment.AppointmentDate,
            startTime: savedAppointment.StartTime,
            status: savedAppointment.Status
        };
    }

    async updateAppointmentStatus(appointmentId: string, status: string): Promise<any> {
        const appointmentRepo = AppDataSource.getRepository(Appointment);
        const appointment = await appointmentRepo.findOne({ where: { Id: Number(appointmentId) } });
        if (!appointment) {
            throw new Error("Appointment not found");
        }
        appointment.Status = status;
        await appointmentRepo.save(appointment);
        return { appointmentId, status: appointment.Status };
    }
}

export const mobileAppointmentService = new MobileAppointmentService();
