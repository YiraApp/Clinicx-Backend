import { AppDataSource } from "../../../../config/database.js";
import { Appointment } from "../../../../models/Appointments/appointment.model.js";
import { HealthcareProvider } from "../../../../models/Organizations/healthcare-provider.model.js";
import { User } from "../../../../models/Account/user.model.js";
import { Hospital } from "../../../../models/Organizations/hospital.model.js";
import { PatientRegistration } from "../../../../models/Organizations/patient-registration.model.js";
import { clinicalNoteRepository } from "../../../../repositories/Appointments/clinical-note.repository.js";
import { ClinicalNote } from "../../../../models/Appointments/clinical-note.model.js";
import { PatientInsurance } from "../../../../models/Organizations/patient-insurance.model.js";
import { PatientMedicalRecord } from "../../../../models/Appointments/patient-medical-record.model.js";
import { PatientPrescription } from "../../../../models/Appointments/patient-prescription.model.js";
import { MedicalDocument } from "../../../../models/Appointments/medical-document.model.js";
import { MedicalRecord } from "../../../../models/Appointments/medical-record.model.js";
import { PatientAccessConsent } from "../../../../models/Consent/patient-access-consent.model.js";

export class MobileDashboardService {
    async getProviderDashboard(userId: string, hospId: number, orgId: number): Promise<any> {
        const providerRepo = AppDataSource.getRepository(HealthcareProvider);
        const userRepo = AppDataSource.getRepository(User);
        const appointmentRepo = AppDataSource.getRepository(Appointment);

        const user = await userRepo.findOne({
            where: { Id: userId }
        });

        if (!user) {
            throw new Error("Provider user not found");
        }

        const provider = await providerRepo.findOne({
            where: { UserId: userId, IsDeleted: false },
            relations: ["User", "Hospital"]
        });

        const hospitalRepo = AppDataSource.getRepository(Hospital);
        const hospital = await hospitalRepo.findOne({
            where: { Id: hospId },
            relations: ["Organization"]
        });

        const hospitalName = hospital?.Name || "";
        const orgName = hospital?.Organization?.Name || "";

        // Determine profile
        let prefix = "";
        const fullName = `${user.FirstName || ""} ${user.LastName || ""}`.trim();
        if (fullName && !fullName.toLowerCase().startsWith("dr.") && !fullName.toLowerCase().startsWith("dr ")) {
            prefix = "Dr. ";
        }

        const profile = {
            name: `${prefix}${fullName}`,
            specialty: provider?.Specialty || "General Practitioner",
            clinicAddress: provider?.Hospital?.Address || (provider?.Hospital?.Name ? `${provider.Hospital.Name}` : "Clinic Branch"),
            profileImageUrl: user.ImagePath || null,
            imagePath: user.ImagePath || null,
        };

        const todayStr = new Date().toISOString().split('T')[0];

        // Find all family user IDs under this account
        let allFamilyUserIds = [userId];
        try {
            const dependents = await userRepo.find({ where: { ParentUserId: userId, IsDeleted: false } });
            if (dependents.length > 0) {
                allFamilyUserIds.push(...dependents.map(d => d.Id));
            }
        } catch (_) { }

        // 2. Fetch today's schedule
        const todaysQuery = appointmentRepo.createQueryBuilder("appointment")
            .leftJoinAndSelect("appointment.User", "user")
            .leftJoinAndSelect("appointment.Doctor", "doctor")
            .where("(appointment.DoctorId = :doctorId OR appointment.UserId IN (:...allFamilyUserIds))", { doctorId: userId, allFamilyUserIds })
            .andWhere("CAST(appointment.AppointmentDate AS DATE) = :todayStr", { todayStr });

        if (hospId && hospId > 0) {
            todaysQuery.andWhere("(appointment.HospitalId = :hospId OR appointment.HospitalId IS NULL)", { hospId });
        }
        if (orgId && orgId > 0) {
            todaysQuery.andWhere("(appointment.OrgId = :orgId OR appointment.OrgId IS NULL)", { orgId });
        }

        const todaysAppointments = await todaysQuery
            .orderBy("appointment.StartTime", "ASC")
            .getMany();

        const formatTime12h = (timeStr: string) => {
            if (!timeStr) return "";
            const parts = timeStr.split(":");
            if (parts.length < 2) return timeStr;
            let hour = parseInt(parts[0], 10);
            const min = parts[1];
            const ampm = hour >= 12 ? "PM" : "AM";
            hour = hour % 12;
            hour = hour ? hour : 12; // the hour '0' should be '12'
            const hourStr = hour < 10 ? `0${hour}` : `${hour}`;
            return `${hourStr}:${min} ${ampm}`;
        };

        const todaysSchedule = todaysAppointments.map(apt => {
            const timeFormatted = formatTime12h(apt.StartTime);
            let patName = apt.User ? `${apt.User.FirstName || ""} ${apt.User.LastName || ""}`.trim() : "";
            if (!patName) {
                patName = apt.Doctor ? `Dr. ${apt.Doctor.FirstName || ""} ${apt.Doctor.LastName || ""}`.trim() : "Patient";
            }
            return {
                patientUserId: apt.UserId,
                orgId: apt.OrgId,
                hospitalId: apt.HospitalId,
                appointmentId: apt.Id,
                patientName: patName || "Patient",
                time: timeFormatted || apt.StartTime,
                consultationType: apt.IsTeleConsultation ? "Teleconsultation" : "In-Clinic Consultation",
                reason: apt.Reason || "Regular Checkup",
                statusTag: apt.IsTeleConsultation ? "LIVE VIDEO" : "IN-CLINIC",
                meetingUrl: apt.MeetingUrl || null
            };
        });

        // 3. Fetch recent patients (past appointments of this provider)
        const recentQuery = appointmentRepo.createQueryBuilder("appointment")
            .leftJoinAndSelect("appointment.User", "user")
            .leftJoinAndSelect("appointment.Doctor", "doctor")
            .where("(appointment.DoctorId = :doctorId OR appointment.UserId IN (:...allFamilyUserIds))", { doctorId: userId, allFamilyUserIds })
            .andWhere("CAST(appointment.AppointmentDate AS DATE) <= :todayStr", { todayStr });

        if (hospId && hospId > 0) {
            recentQuery.andWhere("(appointment.HospitalId = :hospId OR appointment.HospitalId IS NULL)", { hospId });
        }
        if (orgId && orgId > 0) {
            recentQuery.andWhere("(appointment.OrgId = :orgId OR appointment.OrgId IS NULL)", { orgId });
        }

        const recentAppointments = await recentQuery
            .orderBy("appointment.AppointmentDate", "DESC")
            .addOrderBy("appointment.StartTime", "DESC")
            .getMany();

        // Keep only the latest unique patient appointments (limit to 6)
        const uniqueAppointments: any[] = [];
        const seenPatientIds = new Set<string>();
        for (const apt of recentAppointments) {
            if (apt.UserId && !seenPatientIds.has(apt.UserId)) {
                seenPatientIds.add(apt.UserId);
                uniqueAppointments.push(apt);
                if (uniqueAppointments.length >= 6) {
                    break;
                }
            }
        }

        const formatDateSlash = (dateInput: Date | string) => {
            if (!dateInput) return "";
            const d = new Date(dateInput);
            if (isNaN(d.getTime())) return "";
            return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
        };

        const recentPatients = uniqueAppointments.map(apt => {
            let patName = apt.User ? `${apt.User.FirstName || ""} ${apt.User.LastName || ""}`.trim() : "";
            if (!patName) {
                patName = apt.Doctor ? `Dr. ${apt.Doctor.FirstName || ""} ${apt.Doctor.LastName || ""}`.trim() : "Patient";
            }
            return {
                patientUserId: apt.UserId,
                orgId: apt.OrgId,
                hospitalId: apt.HospitalId,
                appointmentId: apt.Id,
                name: patName || "Patient",
                date: formatDateSlash(apt.AppointmentDate),
                consultationType: apt.IsTeleConsultation ? "Teleconsultation" : "In-Clinic Consultation",
                condition: apt.ChiefComplaint || apt.Reason || "Checkup",
                status: apt.Status || "COMPLETED"
            };
        });

        // 4. Calculate stats/metrics aligned with the doctor's actual records
        // Today's appointments count & completed count directly from today's dataset
        const totalToday = todaysAppointments.length;
        const completedToday = todaysAppointments.filter(a => (a.Status || "").toLowerCase().includes("complet")).length;

        // Unique active patients total of this doctor
        const totalPatientsQuery = appointmentRepo.createQueryBuilder("appointment")
            .select("COUNT(DISTINCT appointment.UserId)", "count")
            .where("(appointment.DoctorId = :doctorId OR appointment.UserId IN (:...allFamilyUserIds))", { doctorId: userId, allFamilyUserIds })
            .andWhere("appointment.UserId IS NOT NULL");

        if (hospId && hospId > 0) {
            totalPatientsQuery.andWhere("(appointment.HospitalId = :hospId OR appointment.HospitalId IS NULL)", { hospId });
        }
        if (orgId && orgId > 0) {
            totalPatientsQuery.andWhere("(appointment.OrgId = :orgId OR appointment.OrgId IS NULL)", { orgId });
        }

        const totalPatientsResult = await totalPatientsQuery.getRawOne();
        const totalPatients = parseInt(totalPatientsResult?.count || "0", 10);

        // Unique patients new in the last 7 days
        const newPatientsWeekQuery = appointmentRepo.createQueryBuilder("a1")
            .select("COUNT(DISTINCT a1.UserId)", "count")
            .where("(a1.DoctorId = :doctorId OR a1.UserId IN (:...allFamilyUserIds))", { doctorId: userId, allFamilyUserIds })
            .andWhere("a1.UserId IS NOT NULL")
            .andWhere("a1.AppointmentDate >= CAST(DATEADD(day, -7, GETDATE()) AS DATE)");

        if (hospId && hospId > 0) {
            newPatientsWeekQuery.andWhere("(a1.HospitalId = :hospId OR a1.HospitalId IS NULL)", { hospId });
        }
        if (orgId && orgId > 0) {
            newPatientsWeekQuery.andWhere("(a1.OrgId = :orgId OR a1.OrgId IS NULL)", { orgId });
        }

        const newPatientsWeekResult = await newPatientsWeekQuery.getRawOne();
        const newPatientsThisWeek = parseInt(newPatientsWeekResult?.count || "0", 10);

        const metrics = {
            today: {
                title: "Appointments",
                value: totalToday,
                subtext: totalToday > 0 ? `${completedToday} completed` : "No appointments"
            },
            patients: {
                title: "Total Patients",
                value: totalPatients,
                subtext: newPatientsThisWeek > 0 ? `${newPatientsThisWeek} new this week` : "All time"
            },
            done: {
                title: "Completed",
                value: completedToday,
                subtext: totalToday > 0 ? `${completedToday} completed today` : "Today"
            },
            stats: {
                title: "Weekly Stats",
                value: newPatientsThisWeek,
                subtext: `${newPatientsThisWeek} new patients`
            }
        };

        // 5. Weekly Appointments Graph Data (Mon-Sun)
        const dailyStatsQuery = appointmentRepo.createQueryBuilder("appointment")
            .select("FORMAT(appointment.AppointmentDate, 'ddd')", "day")
            .addSelect("COUNT(*)", "appointments")
            .where("(appointment.DoctorId = :doctorId OR appointment.UserId IN (:...allFamilyUserIds))", { doctorId: userId, allFamilyUserIds })
            .andWhere("appointment.AppointmentDate >= CAST(DATEADD(day, -6, DATEADD(MINUTE, 330, GETUTCDATE())) AS DATE)");

        if (hospId && hospId > 0) {
            dailyStatsQuery.andWhere("(appointment.HospitalId = :hospId OR appointment.HospitalId IS NULL)", { hospId });
        }
        if (orgId && orgId > 0) {
            dailyStatsQuery.andWhere("(appointment.OrgId = :orgId OR appointment.OrgId IS NULL)", { orgId });
        }

        const weeklyStatsRaw = await dailyStatsQuery
            .groupBy("FORMAT(appointment.AppointmentDate, 'ddd')")
            .addGroupBy("CAST(appointment.AppointmentDate AS DATE)")
            .orderBy("CAST(appointment.AppointmentDate AS DATE)", "ASC")
            .getRawMany();

        const dayCounts = { MON: 0, TUE: 0, WED: 0, THU: 0, FRI: 0, SAT: 0, SUN: 0 };
        weeklyStatsRaw.forEach(row => {
            const rawDay = (row.day || "").toUpperCase();
            const dayName = rawDay === "THR" ? "THU" : rawDay;
            if (dayCounts[dayName as keyof typeof dayCounts] !== undefined) {
                dayCounts[dayName as keyof typeof dayCounts] = parseInt(row.appointments || "0", 10);
            }
        });

        const dailyData = [
            { label: "MON", value: dayCounts.MON },
            { label: "TUE", value: dayCounts.TUE },
            { label: "WED", value: dayCounts.WED },
            { label: "THU", value: dayCounts.THU },
            { label: "FRI", value: dayCounts.FRI },
            { label: "SAT", value: dayCounts.SAT },
            { label: "SUN", value: dayCounts.SUN }
        ];

        const totalWeekAppts = Object.values(dayCounts).reduce((a, b) => a + b, 0);
        const averagePerDay = Math.round(totalWeekAppts / 7);

        const weeklyAppointments = {
            averagePerDay,
            dailyData
        };

        // 6. Monthly Patients Graph Data (Jan-Dec) for current year
        const monthlyStatsQuery = appointmentRepo.createQueryBuilder("appointment")
            .select("FORMAT(appointment.AppointmentDate, 'MMM')", "month")
            .addSelect("COUNT(*)", "appointments")
            .where("appointment.DoctorId = :doctorId", { doctorId: userId })
            .andWhere("appointment.AppointmentDate >= CAST(DATEADD(month, -5, DATEADD(MINUTE, 330, GETUTCDATE())) AS DATE)");

        if (hospId) {
            monthlyStatsQuery.andWhere("appointment.HospitalId = :hospId", { hospId });
        }
        if (orgId) {
            monthlyStatsQuery.andWhere("appointment.OrgId = :orgId", { orgId });
        }

        const monthlyStatsRaw = await monthlyStatsQuery
            .groupBy("FORMAT(appointment.AppointmentDate, 'MMM')")
            .addGroupBy("YEAR(appointment.AppointmentDate)")
            .addGroupBy("MONTH(appointment.AppointmentDate)")
            .orderBy("YEAR(appointment.AppointmentDate)", "ASC")
            .addOrderBy("MONTH(appointment.AppointmentDate)", "ASC")
            .getRawMany();

        const monthLabels = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
        const monthlyData = monthLabels.map(label => {
            const row = monthlyStatsRaw.find(r => (r.month || "").toUpperCase() === label);
            return {
                label,
                value: row ? parseInt(row.appointments || "0", 10) : 0
            };
        });

        const yearlyTotal = monthlyData.reduce((sum, item) => sum + item.value, 0);

        const monthlyPatients = {
            yearlyTotal,
            monthlyData
        };

        return {
            orgId,
            orgName,
            hospitalId: hospId,
            hospitalName,
            profile,
            metrics,
            todaysSchedule,
            recentPatients,
            weeklyAppointments,
            monthlyPatients
        };
    }

    async getPatientClinicalData(patientId: string, orgId?: number, hospitalId?: number, appointmentId?: number): Promise<any> {
        const notes = await clinicalNoteRepository.findByPatient(patientId, orgId, hospitalId, appointmentId);

        const formatDateMMMdd = (dateInput: Date | string) => {
            if (!dateInput) return "";
            const d = new Date(dateInput);
            if (isNaN(d.getTime())) return "";
            const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            const day = d.getDate().toString().padStart(2, '0');
            return `${months[d.getMonth()]} ${day}`;
        };

        const providerRepo = AppDataSource.getRepository(HealthcareProvider);
        const userRepo = AppDataSource.getRepository(User);

        const clinical_notes = await Promise.all(notes.map(async (note) => {
            let authorUser = note.Doctor;
            if (!authorUser && note.CreatedBy) {
                const trimmedCreatedBy = note.CreatedBy.trim();
                const allUsers = await userRepo.find({ where: { IsDeleted: false } });
                const found = allUsers.find(u => {
                    const fullName = `${u.FirstName || ""} ${u.LastName || ""}`.trim().toLowerCase();
                    return fullName === trimmedCreatedBy.toLowerCase() ||
                        (u.FirstName && u.FirstName.toLowerCase() === trimmedCreatedBy.toLowerCase());
                });
                if (found) {
                    authorUser = found;
                }
            }

            let authorName = note.CreatedBy || "Unknown User";
            if (authorUser) {
                const provider = await providerRepo.findOne({
                    where: { UserId: authorUser.Id }
                });
                const fullName = `${authorUser.FirstName || ""} ${authorUser.LastName || ""}`.trim();
                if (provider) {
                    authorName = `Dr. ${fullName}`;
                } else {
                    authorName = `Mr. ${fullName}`;
                }
            } else if (authorName && !authorName.toLowerCase().startsWith("dr.") && !authorName.toLowerCase().startsWith("mr.")) {
                authorName = `Mr. ${authorName}`;
            }

            return {
                id: note.Id,
                written_by: authorName,
                date: formatDateMMMdd(note.CreatedAt),
                note: note.Notes || ""
            };
        }));

        return { clinical_notes };
    }

    async getPatientsList(
        doctorId: string,
        orgId: number,
        hospId: number,
        filters?: {
            searchTerm?: string;
            gender?: string;
            status?: string;
        }
    ): Promise<any> {
        const appointmentRepo = AppDataSource.getRepository(Appointment);
        const consentRepo = AppDataSource.getRepository(PatientAccessConsent);
        const regRepo = AppDataSource.getRepository(PatientRegistration);
        const userRepo = AppDataSource.getRepository(User);
        const providerRepo = AppDataSource.getRepository(HealthcareProvider);

        let doctorUserUuid = doctorId;
        let providerIdNum: number | null = null;

        // Resolve doctor UUID if a numeric ID was provided, or find numeric ID if UUID was provided
        if (doctorId && /^\d+$/.test(doctorId)) {
            const hp = await providerRepo.findOne({ where: { Id: Number(doctorId) } }).catch(() => null);
            if (hp) {
                doctorUserUuid = hp.UserId;
                providerIdNum = hp.Id;
            }
        } else if (doctorId) {
            const hp = await providerRepo.findOne({ where: { UserId: doctorId } }).catch(() => null);
            if (hp) {
                providerIdNum = hp.Id;
            }
        }

        const doctorIdCandidates = Array.from(new Set([
            doctorId,
            doctorUserUuid,
            doctorId?.toLowerCase(),
            doctorId?.toUpperCase(),
            doctorUserUuid?.toLowerCase(),
            doctorUserUuid?.toUpperCase(),
            providerIdNum ? String(providerIdNum) : null
        ])).filter((id): id is string => Boolean(id && id.trim().length > 0));

        // 1. Fetch all appointments for this doctor (with or without specific hospital branch)
        const appointments = await appointmentRepo.find({
            where: [
                ...doctorIdCandidates.map(dId => ({ DoctorId: dId, HospitalId: hospId, OrgId: orgId })),
                ...doctorIdCandidates.map(dId => ({ DoctorId: dId })),
            ],
            relations: ["User"],
            order: { AppointmentDate: "DESC", StartTime: "DESC" }
        }).catch(() => []);

        // 2. Fetch all direct doctor-patient connections (e.g. Scanned QR Code, Consents)
        const doctorConsents = await consentRepo.find({
            where: doctorIdCandidates.map(dId => ({ DoctorId: dId })),
            relations: ["Patient"],
            order: { UpdatedAt: "DESC" }
        }).catch(() => []);

        // 3. Fetch all registered patients in this hospital/organization
        const registrations = await regRepo.find({
            where: [
                { HospitalId: hospId, OrganizationId: orgId, IsDeleted: false },
                { HospitalId: hospId, IsDeleted: false },
                { OrganizationId: orgId, IsDeleted: false }
            ],
            relations: ["User"]
        }).catch(() => []);

        // Group appointments by UserId to keep track of visits and latest clinical details
        const patientAppointmentsMap = new Map<string, Appointment[]>();
        appointments.forEach(appt => {
            if (appt.UserId) {
                const uid = appt.UserId.toUpperCase();
                if (!patientAppointmentsMap.has(uid)) {
                    patientAppointmentsMap.set(uid, []);
                }
                patientAppointmentsMap.get(uid)!.push(appt);
            }
        });

        // Collect all distinct patients across Appointments, Consents/QR Scans, and Hospital Registrations
        const allPatientsMap = new Map<string, { user?: User; source: string; consent?: PatientAccessConsent; reg?: PatientRegistration }>();

        // Add users from appointments
        appointments.forEach(appt => {
            if (appt.UserId) {
                const uid = appt.UserId.toUpperCase();
                if (!allPatientsMap.has(uid)) {
                    allPatientsMap.set(uid, { user: appt.User, source: "appointment" });
                }
            }
        });

        // Add users from Consents (QR Code Scans)
        doctorConsents.forEach(c => {
            if (c.PatientId) {
                const uid = c.PatientId.toUpperCase();
                if (!allPatientsMap.has(uid)) {
                    allPatientsMap.set(uid, { user: c.Patient, source: "qr_consent", consent: c });
                }
            }
        });

        // Add users from Hospital Registrations
        registrations.forEach(r => {
            if (r.UserId) {
                const uid = r.UserId.toUpperCase();
                if (!allPatientsMap.has(uid)) {
                    allPatientsMap.set(uid, { user: r.User, source: "registration", reg: r });
                }
            }
        });

        // Ensure User record is populated for every patient
        for (const [uid, item] of allPatientsMap.entries()) {
            if (!item.user || !item.user.FirstName) {
                const u = await userRepo.findOne({ where: { Id: uid } }).catch(() => null);
                if (u) item.user = u;
            }
        }

        const favSet = this.getDoctorFavoriteSet(doctorId);
        const patientDataList = [];

        const formatDateMMMdd = (dateInput: Date | string | null | undefined) => {
            if (!dateInput) return "";
            const d = new Date(dateInput);
            if (isNaN(d.getTime())) return "";
            const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            const day = d.getDate().toString().padStart(2, '0');
            return `${months[d.getMonth()]} ${day}`;
        };

        for (const [uid, item] of allPatientsMap.entries()) {
            const user = item.user;
            if (!user) continue;

            const appts = patientAppointmentsMap.get(uid) || [];
            const totalVisits = appts.length;

            // Fetch registration info for status and allergies
            const reg = item.reg || await regRepo.findOne({
                where: { UserId: user.Id, OrganizationId: orgId, HospitalId: hospId, IsDeleted: false }
            }).catch(() => null) || await regRepo.findOne({
                where: { UserId: user.Id, IsDeleted: false }
            }).catch(() => null);

            let lastVisitDate = "";
            let condition = "General Checkup";

            if (appts.length > 0) {
                const latestAppt = appts[0]!;
                lastVisitDate = formatDateMMMdd(latestAppt.AppointmentDate);
                condition = latestAppt.Reason || latestAppt.ChiefComplaint || "General Checkup";
            } else if (item.consent) {
                lastVisitDate = formatDateMMMdd(item.consent.ApprovedAt || item.consent.RequestedAt || item.consent.CreatedAt);
                condition = item.consent.Notes || "Connected via QR Scan";
            } else if (reg) {
                lastVisitDate = formatDateMMMdd(reg.CreatedAt);
                condition = "Registered Patient";
            } else {
                lastVisitDate = formatDateMMMdd(user.CreatedAt || new Date());
                condition = "Connected Patient";
            }

            const firstLetter = user.FirstName?.charAt(0) || "";
            const lastLetter = user.LastName?.charAt(0) || "";
            const initials = `${firstLetter}${lastLetter}`.toUpperCase() || "PT";

            let age = 0;
            if (user.DateOfBirth) {
                const dob = new Date(user.DateOfBirth);
                const today = new Date();
                age = today.getFullYear() - dob.getFullYear();
                const m = today.getMonth() - dob.getMonth();
                if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
                    age--;
                }
            }

            const genderStr = (user.Gender || "").trim().toLowerCase();
            let gender_id = "01";
            let gender_label = "Other";
            if (genderStr === "male" || genderStr === "m") {
                gender_id = "02";
                gender_label = "Male";
            } else if (genderStr === "female" || genderStr === "f") {
                gender_id = "03";
                gender_label = "Female";
            }

            // Fallback status/id if not explicitly registered in PatientRegistrations
            const status_id = reg ? (reg.Status ? "02" : "01") : "02";
            const status_label = reg ? (reg.Status ? "Active" : "Inactive") : "Active";

            let allergiesArr: string[] = [];
            if (reg && reg.Allergies) {
                try {
                    const parsed = JSON.parse(reg.Allergies);
                    allergiesArr = Array.isArray(parsed) ? parsed : [String(parsed)];
                } catch {
                    allergiesArr = [reg.Allergies];
                }
            }

            const patId = reg ? `YRA${String(reg.Id).padStart(4, "0")}` : `YRA${user.Id.substring(0, 4).toUpperCase()}`;
            const isFav = favSet.has(user.Id) || favSet.has(patId);

            patientDataList.push({
                id: patId,
                userId: user.Id,
                name: `${user.FirstName || ""} ${user.LastName || ""}`.trim() || user.PhoneNumber || "Patient",
                phoneNumber: user.PhoneNumber || "",
                initials,
                age: isNaN(age) || age < 0 ? 0 : age,
                gender_id,
                gender_label,
                status_id,
                status_label,
                condition,
                total_visits: totalVisits,
                last_visit_date: lastVisitDate || "Recent",
                allergies: allergiesArr,
                isFavorite: isFav,
            });
        }

        // Apply filters in memory
        let filteredList = patientDataList;
        if (filters) {
            const { searchTerm, gender, status } = filters;

            if (searchTerm) {
                const term = searchTerm.trim().toLowerCase();
                filteredList = filteredList.filter(patient => {
                    const fullName = (patient.name || "").toLowerCase();
                    const phone = (patient.phoneNumber || "").toLowerCase();
                    return fullName.includes(term) || phone.includes(term);
                });
            }

            if (gender) {
                const gen = gender.trim().toLowerCase();
                if (gen !== "01" && gen !== "all") {
                    filteredList = filteredList.filter(patient => {
                        // Map "others" / "04" to internal gender_id "01"
                        if (gen === "04" || gen === "others" || gen === "other") {
                            return patient.gender_id === "01";
                        }
                        return (patient.gender_label || "").toLowerCase() === gen ||
                            (patient.gender_id || "") === gen;
                    });
                }
            }

            if (status) {
                const stat = status.trim().toLowerCase();
                if (stat === "favorites" || stat === "favorite") {
                    filteredList = filteredList.filter(patient => patient.isFavorite === true);
                } else if (stat !== "01" && stat !== "all") {
                    filteredList = filteredList.filter(patient => {
                        return (patient.status_label || "").toLowerCase() === stat ||
                            (patient.status_id || "") === stat;
                    });
                }
            }
        }

        // Count medical records (clinical notes) for filtered patients in this org/hospital
        let medicalRecordsCount = 0;
        if (filteredList.length > 0) {
            const patientIds = filteredList.map(p => p.userId);
            const clinicalNoteRepo = AppDataSource.getRepository(ClinicalNote);
            medicalRecordsCount = await clinicalNoteRepo.createQueryBuilder("note")
                .where("note.PatientId IN (:...patientIds)", { patientIds })
                .andWhere("note.OrganizationId = :orgId", { orgId })
                .andWhere("note.HospitalId = :hospId", { hospId })
                .getCount();
        }

        return {
            patients: filteredList,
            metrics: {
                total_patients: {
                    value: filteredList.length,
                    label: "Total Patients"
                },
                active_cases: {
                    value: filteredList.filter(p => p.status_label === "Active").length,
                    label: "Active Cases"
                },
                medical_records: {
                    value: medicalRecordsCount,
                    label: "Medical Records"
                }
            }
        };
    }

    // removed getPatientNotesDetail method
    async getPatientOverview(patientId: string, orgId?: number, hospitalId?: number): Promise<any> {
        const userRepo = AppDataSource.getRepository(User);
        const regRepo = AppDataSource.getRepository(PatientRegistration);
        const appointmentRepo = AppDataSource.getRepository(Appointment);
        const insuranceRepo = AppDataSource.getRepository(PatientInsurance);

                let user = await userRepo.findOne({
            where: { Id: patientId },
            relations: ["PermanentAddress", "TemporaryAddress"]
        }).catch(() => null);

        if (!user) {
            user = await userRepo.findOne({
                where: { Id: patientId }
            }).catch(() => null);
        }

        if (!user) {
            user = await userRepo.createQueryBuilder("u")
                .where("LOWER(u.Id) = LOWER(:patientId)", { patientId })
                .getOne()
                .catch(() => null);
        }

        if (!user) {
            user = new User();
            user.Id = patientId;
            user.FirstName = "Patient";
            user.LastName = "";
        }

        const regWhere: any = { UserId: patientId, IsDeleted: false };
        if (orgId) regWhere.OrganizationId = orgId;
        if (hospitalId) regWhere.HospitalId = hospitalId;
        const reg = await regRepo.findOne({
            where: regWhere,
            order: { CreatedAt: "DESC" }
        });

        const insWhere: any = { UserId: patientId, IsDeleted: false };
        if (orgId) insWhere.OrganizationId = orgId;
        if (hospitalId) insWhere.HospitalId = hospitalId;
        const insurance = await insuranceRepo.findOne({
            where: insWhere,
            order: { CreatedAt: "DESC" }
        });

        const apptWhere: any = { UserId: patientId };
        if (orgId) apptWhere.OrgId = orgId;
        if (hospitalId) apptWhere.HospitalId = hospitalId;
        const appointments = await appointmentRepo.find({
            where: { UserId: patientId },
            relations: ["Doctor", "Hospital", "Organization"],
            order: { AppointmentDate: "DESC", StartTime: "DESC" }
        });

        // Format date helpers
        const formatDateMMMddyyyy = (dateInput: Date | string | null | undefined) => {
            if (!dateInput) return "";
            const d = new Date(dateInput);
            if (isNaN(d.getTime())) return "";
            const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            const day = d.getDate();
            const year = d.getFullYear();
            return `${months[d.getMonth()]} ${day}, ${year}`;
        };

        const formatDateMMMddyyyyWithYear = (dateInput: Date | string | null | undefined) => {
            return formatDateMMMddyyyy(dateInput) || "None";
        };

        // Address construction
        const addr = user.PermanentAddress || user.TemporaryAddress;
        let residential_address = "";
        if (addr) {
            residential_address = [
                addr.AddressLine1,
                addr.AddressLine2,
                addr.Landmark,
                addr.City,
                addr.State,
                addr.Pincode ? `pin code - ${addr.Pincode}` : ""
            ].filter(Boolean).join(", ");
        }

        // Visits calculations
        const completedVisits = appointments.filter(a => a.Status === 'Completed').length;
        const totalVisits = completedVisits || appointments.length;

        // Condition
        const latestAppt = appointments[0];
        const condition = latestAppt?.ChiefComplaint || latestAppt?.Reason || reg?.MedicalHistory || "None";

        // Visit history
        const initial_registration = formatDateMMMddyyyyWithYear(reg?.CreatedAt || user.CreatedAt);

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

        // Fetch all appointments globally across all orgs & hospitals for this patient
        const allPatientAppts = await appointmentRepo.createQueryBuilder("apt")
            .leftJoinAndSelect("apt.Doctor", "doctor")
            .leftJoinAndSelect("apt.Hospital", "hospital")
            .leftJoinAndSelect("apt.Organization", "org")
            .where("apt.UserId = :patientId", { patientId })
            .andWhere("LOWER(apt.Status) NOT IN ('cancelled', 'deleted', 'canceled')")
            .orderBy("apt.AppointmentDate", "ASC")
            .addOrderBy("apt.StartTime", "ASC")
            .getMany();

        const todayStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD for today
        const providerRepo = AppDataSource.getRepository(HealthcareProvider);

        // Last check-in visit (past completed appointments or visits before today)
        const pastAppointments = allPatientAppts.filter(a => {
            const aptDateStr = new Date(a.AppointmentDate).toISOString().split("T")[0];
            return aptDateStr < todayStr || a.Status === "Completed";
        }).sort((a, b) => new Date(b.AppointmentDate).getTime() - new Date(a.AppointmentDate).getTime());

        const last_check_in_visit = pastAppointments.length > 0
            ? formatDateMMMddyyyyWithYear(pastAppointments[0].AppointmentDate)
            : initial_registration;

        // Next scheduled appointment (earliest future appointment)
        const futureAppointments = appointments
            .filter(a => new Date(a.AppointmentDate) > new Date())
            .sort((a, b) => new Date(a.AppointmentDate).getTime() - new Date(b.AppointmentDate).getTime());
        const next_scheduled_appointment = futureAppointments.length > 0
            ? formatDateMMMddyyyyWithYear(futureAppointments[0].AppointmentDate)
            : "None";

        const prescriptionRepo = AppDataSource.getRepository(PatientPrescription);
        const docRepo = AppDataSource.getRepository(MedicalDocument);
        const recordRepo = AppDataSource.getRepository(MedicalRecord);
        const noteRepo = AppDataSource.getRepository(ClinicalNote);

        const allPrescriptions = await prescriptionRepo.find({
            where: { PatientId: patientId },
            relations: ["Diagnoses", "Medications", "Doctor"],
            order: { CreatedAt: "DESC" }
        });

        const allNotes = await noteRepo.find({
            where: { PatientId: patientId },
            relations: ["Doctor"],
            order: { CreatedAt: "DESC" }
        });

        const allDocs = await docRepo.find({
            where: { PatientId: patientId },
            relations: ["Doctor"],
            order: { CreatedAt: "DESC" }
        });

        const allRecords = await recordRepo.find({
            where: { PatientId: patientId },
            relations: ["Appointment"],
            order: { CreatedAt: "DESC" }
        });

        const mappedAppointments = appointments.map(a => {
            const apptId = a.Id;
            const apptIdStr = String(apptId).toLowerCase().trim();

            const apptPrescriptions = allPrescriptions.filter(p => p.AppointmentId != null && String(p.AppointmentId).toLowerCase().trim() === apptIdStr);
            const apptNotes = allNotes.filter(n => n.AppointmentId != null && String(n.AppointmentId).toLowerCase().trim() === apptIdStr);
            const apptDocs = allDocs.filter(d => d.AppointmentId != null && String(d.AppointmentId).toLowerCase().trim() === apptIdStr);
            const apptRecords = allRecords.filter(r => r.AppointmentId != null && String(r.AppointmentId).toLowerCase().trim() === apptIdStr);

            return {
                id: String(apptId),
                appointment_number: a.AppointmentNumber ? String(a.AppointmentNumber) : "",
                token_number: a.AppointmentNumber ? String(a.AppointmentNumber).padStart(2, '0') : "",
                appointment_date: formatDateMMMddyyyy(a.AppointmentDate),
                raw_date: a.AppointmentDate,
                start_time: a.StartTime || "",
                end_time: a.EndTime || "",
                duration: a.Duration ? `${a.Duration} mins` : "15 mins",
                condition: a.ChiefComplaint || a.Reason || "General Consultation",
                chief_complaint: a.ChiefComplaint || "",
                reason: a.Reason || a.ChiefComplaint || "",
                status: a.Status || "Confirmed",
                appointment_type: a.AppointmentType || (a.IsTeleConsultation ? "Video Call" : "In-Clinic"),
                is_tele_consultation: a.IsTeleConsultation || false,
                meeting_url: a.MeetingUrl || "",
                location: a.Location || (a.Hospital ? a.Hospital.Name : "Main Clinic"),
                hospital_name: a.Hospital ? a.Hospital.Name : "",
                hospital_address: a.Hospital ? (a.Hospital.Address || "") : "",
                hospital_phone: a.Hospital ? (a.Hospital.MobileNumber || a.Hospital.HelplineNumber || "") : "",
                doctor_id: a.DoctorId || "",
                doctor_name: a.Doctor ? (a.Doctor.FirstName ? `Dr. ${a.Doctor.FirstName} ${a.Doctor.LastName || ''}`.trim() : "Doctor") : "Doctor",
                doctor_email: a.Doctor ? (a.Doctor.Email || "") : "",
                doctor_phone: a.Doctor ? (a.Doctor.PhoneNumber || "") : "",
                notes: a.Notes || "",
                created_at: a.CreatedAt ? formatDateMMMddyyyy(a.CreatedAt) : "",
                created_by: a.CreatedBy || "",
                prescriptions: apptPrescriptions.map(p => ({
                    id: String(p.Id),
                    date: formatDateMMMddyyyy(p.Date || p.CreatedAt),
                    notes: p.Notes || "",
                    doctor_name: p.Doctor ? (p.Doctor.FirstName ? `Dr. ${p.Doctor.FirstName} ${p.Doctor.LastName || ''}`.trim() : "Doctor") : "Doctor",
                    medications: (p.Medications || []).map(m => ({
                        id: String(m.Id),
                        name: m.Medication || "Medication",
                        dosage: m.Dosage || "",
                        frequency: m.FrequencyType || "",
                        duration: m.DurationValue ? `${m.DurationValue} ${m.DurationUnit || 'days'}` : "",
                        instructions: m.Instructions || ""
                    })),
                    diagnoses: (p.Diagnoses || []).map(d => ({
                        id: String(d.Id),
                        name: d.Diagnosis || "",
                        icd10: d.DiagnosisConceptId || ""
                    }))
                })),
                clinical_notes: apptNotes.map(n => ({
                    id: String(n.Id),
                    notes: n.Notes || "",
                    doctor_name: n.Doctor ? (n.Doctor.FirstName ? `Dr. ${n.Doctor.FirstName} ${n.Doctor.LastName || ''}`.trim() : "Doctor") : "Doctor",
                    created_at: formatDateMMMddyyyy(n.CreatedAt)
                })),
                documents: apptDocs.map(d => ({
                    id: String(d.Id),
                    file_name: d.OriginalFileName || d.FileName || "Document",
                    category: d.DocumentCategory || "General",
                    type: d.DocumentType || "Report",
                    file_url: d.BlobUrl || "",
                    created_at: formatDateMMMddyyyy(d.CreatedAt)
                })),
                medical_records: apptRecords.map(r => ({
                    id: String(r.Id),
                    record_type: r.RecordType || "Medical Diagnosis",
                    file_url: r.FileUrl || "",
                    created_at: formatDateMMMddyyyy(r.CreatedAt)
                }))
            };
        });        const medicalRecordRepo = AppDataSource.getRepository(PatientMedicalRecord);
        const recordWhere: any = { PatientId: patientId };
        if (orgId) recordWhere.OrganizationId = orgId;
        if (hospitalId) recordWhere.HospitalId = hospitalId;
        const latestRecord = await medicalRecordRepo.findOne({
            where: recordWhere,
            order: { CreatedAt: "DESC" }
        }).catch(() => null);

        const latest_vitals = {
            blood_pressure: {
                value: latestRecord?.BloodPressure || "None",
                unit: "mmHg"
            },
            pulse: {
                value: latestRecord?.HeartRate || "None",
                unit: "bpm"
            },
            temperature: {
                value: latestRecord?.Temperature || "None",
                unit: "°F"
            },
            spo2: {
                value: "None",
                unit: "%"
            },
            weight: {
                value: latestRecord?.Weight || "None",
                unit: "kg"
            },
            height: {
                value: latestRecord?.Height || "None",
                unit: "cm"
            }
        };

        return {
            contact_information: {
                phone: user.PhoneNumber || "",
                email_address: user.Email || "",
                residential_address: residential_address || "None",
                emergency_contact: {
                    name: user.EmergencyContactName || "None",
                    phone: user.EmergencyContactPhone || "None"
                }
            },
            medical_information: {
                condition,
                allergies: reg?.Allergies || "None",
                blood_group: user.BloodGroup || "None",
                total_visits: totalVisits
            },
            latest_vitals,
            insurance: {
                policy_name: insurance?.InsuranceProvider || "None",
                policy_number: insurance?.InsuranceNumber || "None"
            },
            visit_history: {
                initial_registration,
                last_check_in_visit,
                next_scheduled_appointment
            },
            appointments: mappedAppointments
        };
    }

    async getPatientProfile(patientId: string, orgId?: number, hospitalId?: number): Promise<any> {
        const userRepo = AppDataSource.getRepository(User);
        const regRepo = AppDataSource.getRepository(PatientRegistration);
        const appointmentRepo = AppDataSource.getRepository(Appointment);
        const insuranceRepo = AppDataSource.getRepository(PatientInsurance);
        const medicalRecordRepo = AppDataSource.getRepository(PatientMedicalRecord);

        const user = await userRepo.findOne({
            where: { Id: patientId },
            relations: ["PermanentAddress", "TemporaryAddress"]
        });

        if (!user) {
            throw new Error("Patient not found");
        }

        const regWhere: any = { UserId: patientId, IsDeleted: false };
        if (orgId) regWhere.OrganizationId = orgId;
        if (hospitalId) regWhere.HospitalId = hospitalId;
        const reg = await regRepo.findOne({
            where: regWhere,
            order: { CreatedAt: "DESC" }
        });

        const insWhere: any = { UserId: patientId, IsDeleted: false };
        if (orgId) insWhere.OrganizationId = orgId;
        if (hospitalId) insWhere.HospitalId = hospitalId;
        const insurance = await insuranceRepo.findOne({
            where: insWhere,
            order: { CreatedAt: "DESC" }
        });

        const apptWhere: any = { UserId: patientId };
        if (orgId) apptWhere.OrgId = orgId;
        if (hospitalId) apptWhere.HospitalId = hospitalId;
        const appointments = await appointmentRepo.find({
            where: apptWhere,
            order: { AppointmentDate: "DESC", StartTime: "DESC" }
        });

        const recordWhere: any = { PatientId: patientId };
        if (orgId) recordWhere.OrganizationId = orgId;
        if (hospitalId) recordWhere.HospitalId = hospitalId;
        const latestRecord = await medicalRecordRepo.findOne({
            where: recordWhere,
            order: { CreatedAt: "DESC" }
        });

        // Resolve last visit date
        const formatDateSlash = (dateInput: Date | string | null | undefined) => {
            if (!dateInput) return "";
            const d = new Date(dateInput);
            if (isNaN(d.getTime())) return "";
            return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
        };

        const lastVisitDate = appointments.length > 0
            ? formatDateSlash(appointments[0].AppointmentDate)
            : "None";

        // Resolve age
        let age_label = "None";
        if (user.DateOfBirth) {
            const dob = new Date(user.DateOfBirth);
            const today = new Date();
            let age = today.getFullYear() - dob.getFullYear();
            const m = today.getMonth() - dob.getMonth();
            if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
                age--;
            }
            age_label = `${age} yrs`;
        }

        // Resolve gender
        const genderStr = (user.Gender || "").trim().toLowerCase();
        let gender = "Other";
        if (genderStr === "male" || genderStr === "m") {
            gender = "Male";
        } else if (genderStr === "female" || genderStr === "f") {
            gender = "Female";
        }

        // Resolve location
        const addr = user.PermanentAddress || user.TemporaryAddress;
        let location = "";
        if (addr) {
            location = [addr.City, addr.State].filter(Boolean).join(", ");
        }

        // Resolve latest vitals
        const latest_vitals = {
            blood_pressure: {
                value: latestRecord?.BloodPressure || "None",
                unit: "mmHg"
            },
            pulse: {
                value: latestRecord?.HeartRate || "None",
                unit: "bpm"
            },
            temperature: {
                value: latestRecord?.Temperature || "None",
                unit: "°F"
            },
            spo2: {
                value: "None", // Not in DB schema
                unit: "%"
            },
            weight: {
                value: latestRecord?.Weight || "None",
                unit: "kg"
            },
            height: {
                value: latestRecord?.Height || "None",
                unit: "cm"
            }
        };

        // Global upcoming appointments search across ALL orgs & hospitals for this patient
        const todayStr = new Date().toISOString().split("T")[0];
        const providerRepo = AppDataSource.getRepository(HealthcareProvider);
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

        const formatDateMMMddyyyy = (dateInput: Date | string) => {
            if (!dateInput) return "";
            const d = new Date(dateInput);
            if (isNaN(d.getTime())) return "";
            const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
        };

        const upcomingApptRawList = await appointmentRepo.createQueryBuilder("apt")
            .leftJoinAndSelect("apt.Doctor", "doctor")
            .leftJoinAndSelect("apt.Hospital", "hospital")
            .leftJoinAndSelect("apt.Organization", "org")
            .where("apt.UserId = :patientId", { patientId })
            .andWhere("CAST(apt.AppointmentDate AS DATE) >= :todayStr", { todayStr })
            .andWhere("LOWER(apt.Status) NOT IN ('cancelled', 'deleted', 'canceled')")
            .andWhere("apt.Status != 'Completed'")
            .orderBy("CAST(apt.AppointmentDate AS DATE)", "ASC")
            .addOrderBy("apt.StartTime", "ASC")
            .getMany();

        const upcoming_appointments = await Promise.all(upcomingApptRawList.map(async (apt) => {
            const docName = apt.Doctor ? `Dr. ${apt.Doctor.FirstName || ""} ${apt.Doctor.LastName || ""}`.trim() : "Healthcare Provider";
            let doctorSpecialty = "General Practitioner";
            if (apt.DoctorId) {
                const hp = await providerRepo.findOne({ where: { UserId: apt.DoctorId, IsDeleted: false } });
                if (hp?.Specialty) doctorSpecialty = hp.Specialty;
            }

            return {
                id: apt.Id,
                appointment_id: String(apt.Id),
                doctor_name: docName,
                doctor_id: apt.DoctorId,
                doctor_specialty: doctorSpecialty,
                hospital_id: apt.HospitalId,
                hospital_name: apt.Hospital?.Name || "",
                org_id: apt.OrgId,
                org_name: apt.Organization?.Name || "",
                appointment_date: apt.AppointmentDate,
                formatted_date: formatDateMMMddyyyy(apt.AppointmentDate),
                start_time: apt.StartTime,
                formatted_time: formatTime12h(apt.StartTime),
                consultation_type: apt.IsTeleConsultation ? "Video Consultation" : (apt.AppointmentType || "In-Person"),
                is_teleconsultation: apt.IsTeleConsultation || false,
                reason: apt.Reason || apt.ChiefComplaint || "Regular Checkup",
                status: apt.Status || "Scheduled",
                meeting_url: apt.MeetingUrl || null
            };
        }));

        const next_appointment = upcoming_appointments.length > 0 ? upcoming_appointments[0] : null;

        // Fetch recent medical documents globally across ALL orgs & hospitals for this patient
        const docRepo = AppDataSource.getRepository(MedicalDocument);
        const docWhere: any = { PatientId: patientId, IsDeleted: false };
        if (orgId) docWhere.OrganizationId = orgId;
        if (hospitalId) docWhere.HospitalId = hospitalId;

        const medicalDocsRaw = await docRepo.find({
            where: docWhere,
            relations: ["Hospital", "Organization", "Appointment"],
            order: { CreatedAt: "DESC" },
            take: 2
        });

        const recent_medical_documents = medicalDocsRaw.map(doc => {
            return {
                id: doc.Id,
                document_id: String(doc.Id),
                file_name: doc.FileName || doc.OriginalFileName || "Medical Document",
                document_type: doc.DocumentType || "PDF",
                document_category: doc.DocumentCategory || "General",
                blob_url: doc.BlobUrl || "",
                file_size: doc.FileSize || 0,
                is_patient_uploaded: doc.IsPatientUploaded || false,
                is_doctor_uploaded: doc.IsDoctorUploaded || false,
                appointment_id: doc.AppointmentId || null,
                hospital_id: doc.HospitalId,
                hospital_name: doc.Hospital?.Name || "",
                org_id: doc.OrganizationId,
                org_name: doc.Organization?.Name || "",
                created_at: doc.CreatedAt,
                formatted_date: formatDateMMMddyyyy(doc.CreatedAt)
            };
        });

        return {
            patient_info: {
                patient_id: user.Id,
                patient_number: reg ? `YRA${String(reg.Id).padStart(4, "0")}` : "YRA0000",
                appointment_id: appointments.length > 0 ? String(appointments[0].Id) : "None",
                name: `${user.FirstName || ""} ${user.LastName || ""}`.trim(),
                age: age_label,
                gender,
                last_visit: lastVisitDate
            },
            contact_information: {
                phone: user.PhoneNumber || "",
                email: user.Email || "",
                location: location || "None"
            },
            medical_information: {
                blood_group: user.BloodGroup || "None"
            },
            insurance: {
                provider: insurance?.InsuranceProvider || "None",
                policy_number: insurance?.InsuranceNumber || "None",
                valid_till: "None"
            }
        };
    }

    /**
     * Retrieves detailed profile of a healthcare provider / doctor.
     */
    async getProviderProfile(userId: string, hospId?: number, orgId?: number): Promise<any> {
        const userRepo = AppDataSource.getRepository(User);
        const providerRepo = AppDataSource.getRepository(HealthcareProvider);
        const hospitalRepo = AppDataSource.getRepository(Hospital);

        const user = await userRepo.findOne({
            where: { Id: userId }
        });

        if (!user) {
            throw new Error("Provider user not found");
        }

        const provider = await providerRepo.findOne({
            where: { UserId: userId, IsDeleted: false },
            relations: ["Hospital", "Hospital.Organization"]
        });

        let targetHospId = hospId || provider?.HospitalId;
        let targetOrgId = orgId || provider?.Hospital?.OrganizationId;

        let hospital: Hospital | null = null;
        if (targetHospId) {
            hospital = await hospitalRepo.findOne({
                where: { Id: targetHospId },
                relations: ["Organization"]
            });
        }

        let prefix = "";
        const fullName = `${user.FirstName || ""} ${user.LastName || ""}`.trim();
        if (fullName && !fullName.toLowerCase().startsWith("dr.") && !fullName.toLowerCase().startsWith("dr ")) {
            prefix = "Dr. ";
        }

        return {
            id: provider?.Id || 0,
            userId: user.Id,
            name: `${prefix}${fullName}`,
            firstName: user.FirstName || "",
            lastName: user.LastName || "",
            email: user.Email || "",
            phoneNumber: user.PhoneNumber || "",
            gender: user.Gender || "Not Specified",
            dob: user.DateOfBirth ? String(user.DateOfBirth) : "",
            bloodGroup: user.BloodGroup || "O+",
            imagePath: user.ImagePath || null,
            profileImageUrl: user.ImagePath || null,
            specialty: provider?.Specialty || "General Practitioner",
            subSpecialty: provider?.SubSpecialty || "Family Medicine",
            department: provider?.Department || "General Medicine",
            registrationNumber: provider?.RegistrationNumber || "REG-YIRA-" + (user.Id.substring(0, 8).toUpperCase()),
            qualification: provider?.Qualification || "MBBS, MD",
            experience: provider?.Experience || "8+ Years",
            consultationFee: provider?.ConsultationFee ? Number(provider.ConsultationFee) : 500,
            bio: provider?.Bio || "Dedicated medical practitioner committed to providing comprehensive healthcare and clinical excellence.",
            hospitalId: hospital?.Id || targetHospId || 0,
            hospitalName: hospital?.Name || provider?.Hospital?.Name || "Primary Care Clinic",
            clinicAddress: [hospital?.Address, hospital?.City, hospital?.State].filter(Boolean).join(", ") || hospital?.Address || provider?.Hospital?.Address || "Central Healthcare Facility",
            hospitalCode: hospital?.HospitalCode || "",
            hospitalType: hospital?.HospitalType || "",
            orgId: hospital?.Organization?.Id || targetOrgId || 0,
            orgName: hospital?.Organization?.Name || "Yira Health Network",
            isEmailVerified: user.IsEmailVerified ?? true,
            isMobileVerified: user.IsMobileVerified ?? true
        };
    }

    /**
     * Updates doctor personal and professional profile details.
     */
    async updateProviderProfile(userId: string, data: any): Promise<any> {
        const userRepo = AppDataSource.getRepository(User);
        const providerRepo = AppDataSource.getRepository(HealthcareProvider);

        const user = await userRepo.findOne({ where: { Id: userId } });
        if (!user) {
            throw new Error("Provider user not found");
        }

        // Update User personal details
        if (data.firstName !== undefined) user.FirstName = data.firstName;
        if (data.lastName !== undefined) user.LastName = data.lastName;
        if (data.email !== undefined) user.Email = data.email;
        if (data.phoneNumber !== undefined) user.PhoneNumber = data.phoneNumber;
        if (data.gender !== undefined) user.Gender = data.gender;
        if (data.dob !== undefined || data.dateOfBirth !== undefined) {
            const dobVal = data.dob || data.dateOfBirth;
            user.DateOfBirth = dobVal && dobVal !== "" ? String(dobVal) : user.DateOfBirth;
        }
        if (data.bloodGroup !== undefined) user.BloodGroup = data.bloodGroup;
        if (data.imagePath !== undefined) user.ImagePath = data.imagePath;
        if (data.profileImageUrl !== undefined) user.ImagePath = data.profileImageUrl;
        user.UpdatedAt = new Date();

        await userRepo.save(user);

        // Update or create HealthcareProvider record
        let provider = await providerRepo.findOne({
            where: { UserId: userId, IsDeleted: false }
        });

        if (provider) {
            if (data.specialty !== undefined) provider.Specialty = data.specialty;
            if (data.subSpecialty !== undefined) provider.SubSpecialty = data.subSpecialty;
            if (data.department !== undefined) provider.Department = data.department;
            if (data.registrationNumber !== undefined) provider.RegistrationNumber = data.registrationNumber;
            if (data.qualification !== undefined) provider.Qualification = data.qualification;
            if (data.experience !== undefined) provider.Experience = data.experience;
            if (data.consultationFee !== undefined) provider.ConsultationFee = Number(data.consultationFee);
            if (data.bio !== undefined) provider.Bio = data.bio;
            if (data.hospitalId !== undefined && !isNaN(Number(data.hospitalId))) {
                provider.HospitalId = Number(data.hospitalId);
            }
            provider.UpdatedAt = new Date();
            await providerRepo.save(provider);
        } else {
            provider = providerRepo.create({
                UserId: userId,
                HospitalId: data.hospitalId ? Number(data.hospitalId) : 19,
                Specialty: data.specialty || "General Practitioner",
                SubSpecialty: data.subSpecialty || "Family Medicine",
                Department: data.department || "General Medicine",
                RegistrationNumber: data.registrationNumber || "REG-YIRA-" + (userId.substring(0, 8).toUpperCase()),
                Qualification: data.qualification || "MBBS, MD",
                Experience: data.experience || "8+ Years",
                ConsultationFee: data.consultationFee ? Number(data.consultationFee) : 500,
                Bio: data.bio || "Dedicated medical practitioner committed to providing comprehensive healthcare and clinical excellence.",
                IsDeleted: false,
                CreatedAt: new Date()
            });
            await providerRepo.save(provider);
        }

        return await this.getProviderProfile(userId, data.hospitalId, data.orgId);
    }

    /**
     * Uploads provider profile photo and updates user record.
     */
    async uploadProviderPhoto(userId: string, file: Express.Multer.File): Promise<any> {
        const userRepo = AppDataSource.getRepository(User);
        const user = await userRepo.findOne({ where: { Id: userId } });
        if (!user) {
            throw new Error("Provider user not found");
        }

        let photoUrl = "";
        try {
            const { blobService } = await import("../../../../services/Common/blob.service.js");
            const uploadResult = await blobService.uploadFiles([file], userId, "profiles");
            if (uploadResult && uploadResult.length > 0) {
                photoUrl = uploadResult[0].fileUrl;
            }
        } catch (blobErr: any) {
            console.warn("[Mobile Dashboard] Blob upload fallback to base64:", blobErr.message);
            photoUrl = `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
        }

        user.ImagePath = photoUrl;
        user.UpdatedAt = new Date();
        await userRepo.save(user);

        return {
            photoUrl,
            imagePath: photoUrl,
            message: "Profile photo uploaded successfully"
        };
    }

    private doctorFavoritesMap = new Map<string, Set<string>>();

    getDoctorFavoriteSet(doctorId: string): Set<string> {
        const key = String(doctorId || 'default').trim().toLowerCase();
        if (!this.doctorFavoritesMap.has(key)) {
            this.doctorFavoritesMap.set(key, new Set<string>());
        }
        return this.doctorFavoritesMap.get(key)!;
    }

    async toggleFavoritePatient(doctorId: string, patientId: string, isFavExplicit?: boolean): Promise<{ isFavorite: boolean }> {
        const favSet = this.getDoctorFavoriteSet(doctorId);
        const pId = String(patientId).trim();
        let isFav: boolean;
        if (typeof isFavExplicit === 'boolean') {
            if (isFavExplicit) {
                favSet.add(pId);
            } else {
                favSet.delete(pId);
            }
            isFav = isFavExplicit;
        } else {
            if (favSet.has(pId)) {
                favSet.delete(pId);
                isFav = false;
            } else {
                favSet.add(pId);
                isFav = true;
            }
        }
        return { isFavorite: isFav };
    }

    async getFavoritePatients(doctorId: string, orgId: number, hospId: number): Promise<any> {
        const favSet = this.getDoctorFavoriteSet(doctorId);
        const allPatientsResult = await this.getPatientsList(doctorId, orgId, hospId);
        const allPatients: any[] = allPatientsResult?.patients || [];
        const favPatients = allPatients.filter(p => favSet.has(p.userId) || favSet.has(p.id) || p.isFavorite);
        return {
            patients: favPatients,
            total: favPatients.length
        };
    }
}

export const mobileDashboardService = new MobileDashboardService();


