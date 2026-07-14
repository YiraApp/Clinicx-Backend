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
            clinicAddress: provider?.Hospital?.Address || (provider?.Hospital?.Name ? `${provider.Hospital.Name}` : "Clinic Branch")
        };

        const todayStr = new Date().toISOString().split('T')[0];

        // 2. Fetch today's schedule
        const todaysQuery = appointmentRepo.createQueryBuilder("appointment")
            .leftJoinAndSelect("appointment.User", "user")
            .where("appointment.DoctorId = :doctorId", { doctorId: userId })
            .andWhere("CAST(appointment.AppointmentDate AS DATE) = :todayStr", { todayStr });

        if (hospId) {
            todaysQuery.andWhere("appointment.HospitalId = :hospId", { hospId });
        }
        if (orgId) {
            todaysQuery.andWhere("appointment.OrgId = :orgId", { orgId });
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
            return {
                patientUserId: apt.UserId,
                orgId: apt.OrgId,
                hospitalId: apt.HospitalId,
                appointmentId: apt.Id,
                patientName: `${apt.User?.FirstName || ""} ${apt.User?.LastName || ""}`.trim(),
                time: timeFormatted || apt.StartTime,
                consultationType: apt.IsTeleConsultation ? "Teleconsultation" : "In-Clinic Consultation",
                reason: apt.Reason || "Regular Checkup",
                statusTag: apt.IsTeleConsultation ? "LIVE VIDEO" : "IN-CLINIC"
            };
        });

        // 3. Fetch recent patients (past appointments of this provider)
        const recentQuery = appointmentRepo.createQueryBuilder("appointment")
            .leftJoinAndSelect("appointment.User", "user")
            .where("appointment.DoctorId = :doctorId", { doctorId: userId })
            .andWhere("CAST(appointment.AppointmentDate AS DATE) <= :todayStr", { todayStr });

        if (hospId) {
            recentQuery.andWhere("appointment.HospitalId = :hospId", { hospId });
        }
        if (orgId) {
            recentQuery.andWhere("appointment.OrgId = :orgId", { orgId });
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
            return {
                patientUserId: apt.UserId,
                orgId: apt.OrgId,
                hospitalId: apt.HospitalId,
                appointmentId: apt.Id,
                name: `${apt.User?.FirstName || ""} ${apt.User?.LastName || ""}`.trim(),
                date: formatDateSlash(apt.AppointmentDate),
                consultationType: apt.IsTeleConsultation ? "Teleconsultation" : "In-Clinic Consultation",
                condition: apt.ChiefComplaint || apt.Reason || "Checkup",
                status: apt.Status || "COMPLETED"
            };
        });

        // 4. Calculate stats/metrics aligned 100% with the web doctor dashboard calculations
        // Today's appointments count & completed count
        const todayStatsQuery = appointmentRepo.createQueryBuilder("appointment")
            .select("COUNT(*)", "totalToday")
            .addSelect("COUNT(CASE WHEN appointment.Status = 'Completed' THEN 1 END)", "completedToday")
            .where("appointment.DoctorId = :doctorId", { doctorId: userId })
            .andWhere("CAST(appointment.AppointmentDate AS DATE) = CAST(DATEADD(MINUTE, 330, GETUTCDATE()) AS DATE)");

        if (hospId) {
            todayStatsQuery.andWhere("appointment.HospitalId = :hospId", { hospId });
        }
        if (orgId) {
            todayStatsQuery.andWhere("appointment.OrgId = :orgId", { orgId });
        }

        const todayStatsResult = await todayStatsQuery.getRawOne();
        const totalToday = parseInt(todayStatsResult?.totalToday || "0", 10);
        const completedToday = parseInt(todayStatsResult?.completedToday || "0", 10);

        // Unique active patients total
        const totalPatientsQuery = appointmentRepo.createQueryBuilder("appointment")
            .select("COUNT(DISTINCT appointment.UserId)", "count")
            .innerJoin("Users", "user", "appointment.UserId = user.Id AND user.Status = 1 AND user.IsDeleted = 0")
            .innerJoin("UserRoles", "ur", "ur.UserId = appointment.UserId AND ur.OrganizationId = appointment.OrgId AND ur.RoleId = '4FC67429-28AE-4106-93EF-436228282ED0' AND ur.Status = 1 AND ur.IsDeleted = 0")
            .where("appointment.DoctorId = :doctorId", { doctorId: userId });

        if (hospId) {
            totalPatientsQuery.andWhere("appointment.HospitalId = :hospId", { hospId });
        }
        if (orgId) {
            totalPatientsQuery.andWhere("appointment.OrgId = :orgId", { orgId });
        }

        const totalPatientsResult = await totalPatientsQuery.getRawOne();
        const totalPatients = parseInt(totalPatientsResult?.count || "0", 10);

        // Unique patients new this week
        const newPatientsWeekQuery = appointmentRepo.createQueryBuilder("a1")
            .select("COUNT(DISTINCT a1.UserId)", "count")
            .innerJoin("Users", "u1", "a1.UserId = u1.Id AND u1.Status = 1 AND u1.IsDeleted = 0")
            .innerJoin("UserRoles", "ur1", "ur1.UserId = a1.UserId AND ur1.OrganizationId = a1.OrgId AND ur1.RoleId = '4FC67429-28AE-4106-93EF-436228282ED0' AND ur1.Status = 1 AND ur1.IsDeleted = 0")
            .where("a1.DoctorId = :doctorId", { doctorId: userId })
            .andWhere("a1.AppointmentDate >= DATEADD(day, -DATEPART(weekday, DATEADD(MINUTE, 330, GETUTCDATE())) + 1, DATEADD(MINUTE, 330, GETUTCDATE()))");

        if (hospId) {
            newPatientsWeekQuery.andWhere("a1.HospitalId = :hospId", { hospId });
        }
        if (orgId) {
            newPatientsWeekQuery.andWhere("a1.OrgId = :orgId", { orgId });
        }

        newPatientsWeekQuery.andWhere(`NOT EXISTS (
            SELECT 1 FROM Appointments a2
            WHERE a2.UserId = a1.UserId 
            AND a2.DoctorId = a1.DoctorId 
            ${orgId ? `AND a2.OrgId = ${orgId}` : ''}
            AND a2.AppointmentDate < DATEADD(day, -DATEPART(weekday, DATEADD(MINUTE, 330, GETUTCDATE())) + 1, DATEADD(MINUTE, 330, GETUTCDATE()))
        )`);

        const newPatientsWeekResult = await newPatientsWeekQuery.getRawOne();
        const newPatientsThisWeek = parseInt(newPatientsWeekResult?.count || "0", 10);

        // Completed appointments total & follow-ups count
        const doneStatsQuery = appointmentRepo.createQueryBuilder("appointment")
            .select("COUNT(*)", "totalCompleted")
            .addSelect("COUNT(CASE WHEN (appointment.ParentAppointmentId IS NOT NULL OR appointment.Reason LIKE :follow) THEN 1 END)", "followUpsCount")
            .where("appointment.DoctorId = :doctorId", { doctorId: userId })
            .andWhere("appointment.Status = :status", { status: "Completed" })
            .setParameter("follow", "%follow%");

        if (hospId) {
            doneStatsQuery.andWhere("appointment.HospitalId = :hospId", { hospId });
        }
        if (orgId) {
            doneStatsQuery.andWhere("appointment.OrgId = :orgId", { orgId });
        }

        const doneStatsResult = await doneStatsQuery.getRawOne();
        const totalCompleted = parseInt(doneStatsResult?.totalCompleted || "0", 10);
        const followUpsCount = parseInt(doneStatsResult?.followUpsCount || "0", 10);

        const metrics = {
            today: {
                title: "Today",
                value: totalToday,
                subtext: `${completedToday} completed`
            },
            patients: {
                title: "Patients",
                value: totalPatients,
                subtext: `${newPatientsThisWeek} new this week`
            },
            done: {
                title: "Done",
                value: totalCompleted,
                subtext: `${followUpsCount} follow-ups`
            },
            stats: {
                title: "Stats",
                value: newPatientsThisWeek,
                subtext: `${newPatientsThisWeek} new patients`
            }
        };

        // 5. Weekly Appointments Graph Data (Mon-Sun)
        const dailyStatsQuery = appointmentRepo.createQueryBuilder("appointment")
            .select("FORMAT(appointment.AppointmentDate, 'ddd')", "day")
            .addSelect("COUNT(*)", "appointments")
            .where("appointment.DoctorId = :doctorId", { doctorId: userId })
            .andWhere("appointment.AppointmentDate >= CAST(DATEADD(day, -6, DATEADD(MINUTE, 330, GETUTCDATE())) AS DATE)");

        if (hospId) {
            dailyStatsQuery.andWhere("appointment.HospitalId = :hospId", { hospId });
        }
        if (orgId) {
            dailyStatsQuery.andWhere("appointment.OrgId = :orgId", { orgId });
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
        
        // Fetch all appointments for this doctor at this hospital and organization
        const appointments = await appointmentRepo.find({
            where: { DoctorId: doctorId, HospitalId: hospId, OrgId: orgId },
            relations: ["User"],
            order: { AppointmentDate: "DESC", StartTime: "DESC" }
        });

        // Group appointments by UserId to keep only unique patients treated by this doctor
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

        const regRepo = AppDataSource.getRepository(PatientRegistration);
        const patientDataList = [];

        for (const [uid, appts] of patientAppointmentsMap.entries()) {
            const latestAppt = appts[0]!;
            const user = latestAppt.User;
            if (!user) continue;

            // Fetch registration info for status and allergies
            const reg = await regRepo.findOne({
                where: { UserId: user.Id, OrganizationId: orgId, HospitalId: hospId, IsDeleted: false }
            });

            const totalVisits = appts.length;
            
            const formatDateMMMdd = (dateInput: Date | string) => {
                if (!dateInput) return "";
                const d = new Date(dateInput);
                if (isNaN(d.getTime())) return "";
                const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                const day = d.getDate().toString().padStart(2, '0');
                return `${months[d.getMonth()]} ${day}`;
            };

            const lastVisitDate = formatDateMMMdd(latestAppt.AppointmentDate);
            const condition = latestAppt.Reason || latestAppt.ChiefComplaint || "General Checkup";

            const firstLetter = user.FirstName?.charAt(0) || "";
            const lastLetter = user.LastName?.charAt(0) || "";
            const initials = `${firstLetter}${lastLetter}`.toUpperCase();

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

            patientDataList.push({
                id: reg ? `YRA${String(reg.Id).padStart(4, "0")}` : `YRA0000`,
                userId: user.Id,
                name: `${user.FirstName || ""} ${user.LastName || ""}`.trim(),
                phoneNumber: user.PhoneNumber || "",
                initials,
                age,
                gender_id,
                gender_label,
                status_id,
                status_label,
                condition,
                total_visits: totalVisits,
                last_visit_date: lastVisitDate,
                allergies: allergiesArr
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
                if (stat !== "01" && stat !== "all") {
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
    async getPatientOverview(patientId: string, orgId: number, hospitalId: number): Promise<any> {
        const userRepo = AppDataSource.getRepository(User);
        const regRepo = AppDataSource.getRepository(PatientRegistration);
        const appointmentRepo = AppDataSource.getRepository(Appointment);
        const insuranceRepo = AppDataSource.getRepository(PatientInsurance);

        const user = await userRepo.findOne({
            where: { Id: patientId },
            relations: ["PermanentAddress", "TemporaryAddress"]
        });

        if (!user) {
            throw new Error("Patient not found");
        }

        const reg = await regRepo.findOne({
            where: { UserId: patientId, OrganizationId: orgId, HospitalId: hospitalId, IsDeleted: false }
        });

        const insurance = await insuranceRepo.findOne({
            where: { UserId: patientId, OrganizationId: orgId, HospitalId: hospitalId, IsDeleted: false }
        });

        const appointments = await appointmentRepo.find({
            where: { UserId: patientId, OrgId: orgId, HospitalId: hospitalId },
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
        
        // Last check-in visit (most recent past appointment)
        const now = new Date();
        const pastAppointments = appointments.filter(a => new Date(a.AppointmentDate) <= now);
        const last_check_in_visit = pastAppointments.length > 0
            ? formatDateMMMddyyyyWithYear(pastAppointments[0].AppointmentDate)
            : initial_registration;

        // Next scheduled appointment (earliest future appointment)
        const futureAppointments = appointments
            .filter(a => new Date(a.AppointmentDate) > now)
            .sort((a, b) => new Date(a.AppointmentDate).getTime() - new Date(b.AppointmentDate).getTime());
        const next_scheduled_appointment = futureAppointments.length > 0
            ? formatDateMMMddyyyyWithYear(futureAppointments[0].AppointmentDate)
            : "None";

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
            insurance: {
                policy_name: insurance?.InsuranceProvider || "None",
                policy_number: insurance?.InsuranceNumber || "None"
            },
            visit_history: {
                initial_registration,
                last_check_in_visit,
                next_scheduled_appointment
            }
        };
    }

    async getPatientProfile(patientId: string, orgId: number, hospitalId: number): Promise<any> {
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

        const reg = await regRepo.findOne({
            where: { UserId: patientId, OrganizationId: orgId, HospitalId: hospitalId, IsDeleted: false }
        });

        const insurance = await insuranceRepo.findOne({
            where: { UserId: patientId, OrganizationId: orgId, HospitalId: hospitalId, IsDeleted: false }
        });

        const appointments = await appointmentRepo.find({
            where: { UserId: patientId, OrgId: orgId, HospitalId: hospitalId },
            order: { AppointmentDate: "DESC", StartTime: "DESC" }
        });

        const latestRecord = await medicalRecordRepo.findOne({
            where: { PatientId: patientId, OrganizationId: orgId, HospitalId: hospitalId },
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
            latest_vitals,
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
}

export const mobileDashboardService = new MobileDashboardService();
