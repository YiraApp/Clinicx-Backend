import { AppDataSource } from "../../../../config/database.js";
import { PatientAccessConsent } from "../../../../models/Consent/patient-access-consent.model.js";
import { User } from "../../../../models/Account/user.model.js";
import { UserRole } from "../../../../models/Account/userrole.model.js";
import { Role } from "../../../../models/Account/role.model.js";
import { PatientRegistration } from "../../../../models/Organizations/patient-registration.model.js";
import { HealthcareProvider } from "../../../../models/Organizations/healthcare-provider.model.js";
import { Hospital } from "../../../../models/Organizations/hospital.model.js";
import { v4 as uuidv4 } from "uuid";

export class PatientAccessConsentService {
    private consentRepo = AppDataSource.getRepository(PatientAccessConsent);
    private userRepo = AppDataSource.getRepository(User);
    private providerRepo = AppDataSource.getRepository(HealthcareProvider);
    private hospitalRepo = AppDataSource.getRepository(Hospital);

    private getDurationMinutes(duration: string): number {
        switch (duration?.toUpperCase()) {
            case "1_HOUR":
            case "1 HOUR":
                return 60;
            case "5_HOURS":
            case "5 HOURS":
                return 300;
            case "1_DAY":
            case "1 DAY":
                return 1440;
            case "3_DAYS":
            case "3 DAYS":
                return 4320;
            case "7_DAYS":
            case "7 DAYS":
                return 10080;
            case "1_MONTH":
            case "1 MONTH":
                return 43200;
            case "NEVER":
            case "PERMANENT":
                return 0; // 0 means no expiration
            default:
                return 1440; // Default 1 day
        }
    }

    private getDurationLabel(duration: string): string {
        switch (duration?.toUpperCase()) {
            case "1_HOUR":
                return "1 Hour";
            case "5_HOURS":
                return "5 Hours";
            case "1_DAY":
                return "1 Day";
            case "3_DAYS":
                return "3 Days";
            case "7_DAYS":
                return "7 Days";
            case "1_MONTH":
                return "1 Month";
            case "NEVER":
                return "Permanent (Never)";
            default:
                return duration || "1 Day";
        }
    }

    /**
     * Doctor creates or renews a medical records access request.
     */
    async requestAccess(
        patientId: string,
        doctorId: string,
        hospitalId?: number,
        duration: string = "7_DAYS",
        notes?: string
    ): Promise<any> {
        if (!patientId || !doctorId) {
            throw new Error("patientId and doctorId are required");
        }

        const durationMinutes = this.getDurationMinutes(duration);

        // Find if an existing request exists between this doctor and patient
        let existing = await this.consentRepo.findOne({
            where: { PatientId: patientId, DoctorId: doctorId },
            order: { Id: "DESC" }
        });

        if (existing) {
            existing.Duration = duration;
            existing.DurationMinutes = durationMinutes;
            existing.Status = "PENDING";
            existing.RequestedAt = new Date();
            existing.ApprovedAt = undefined;
            existing.ExpiresAt = undefined;
            if (hospitalId) existing.HospitalId = hospitalId;
            if (notes) existing.Notes = notes;
            existing.UpdatedAt = new Date();
            await this.consentRepo.save(existing);
            return {
                ...existing,
                durationLabel: this.getDurationLabel(existing.Duration)
            };
        }

        const newConsent = this.consentRepo.create({
            PatientId: patientId,
            DoctorId: doctorId,
            HospitalId: hospitalId || undefined,
            Duration: duration,
            DurationMinutes: durationMinutes,
            Status: "PENDING",
            RequestedAt: new Date(),
            Notes: notes
        });

        const saved = await this.consentRepo.save(newConsent);
        return {
            ...saved,
            durationLabel: this.getDurationLabel(saved.Duration)
        };
    }

    /**
     * Checks whether doctor has approved active access to patient records.
     */
    async checkAccess(patientId: string, doctorId: string): Promise<any> {
        if (!patientId || !doctorId) {
            return { hasAccess: false, status: "NO_REQUEST", consent: null };
        }

        const consent = await this.consentRepo.findOne({
            where: { PatientId: patientId, DoctorId: doctorId },
            order: { Id: "DESC" }
        });

        let hasActiveConsent = false;
        const now = new Date();

        if (consent && consent.Status === "APPROVED") {
            // Check if expired
            if (consent.DurationMinutes > 0 && consent.ExpiresAt && consent.ExpiresAt < now) {
                consent.Status = "EXPIRED";
                consent.UpdatedAt = now;
                await this.consentRepo.save(consent);
            } else {
                hasActiveConsent = true;
                let remainingMinutes: number | null = null;
                if (consent.ExpiresAt) {
                    remainingMinutes = Math.max(0, Math.floor((consent.ExpiresAt.getTime() - now.getTime()) / (1000 * 60)));
                }

                return {
                    hasAccess: true,
                    status: "APPROVED",
                    consent,
                    expiresAt: consent.ExpiresAt,
                    remainingMinutes,
                    durationLabel: this.getDurationLabel(consent.Duration)
                };
            }
        }

        // Check if doctor has treated this patient and is linked to the hospital
        try {
            const { Appointment } = await import("../../../../models/Appointments/appointment.model.js");
            const appointmentRepo = AppDataSource.getRepository(Appointment);
            const treatedAppointment = await appointmentRepo.createQueryBuilder("a")
                .where("a.UserId = :patientId", { patientId })
                .andWhere("a.DoctorId = :doctorId", { doctorId })
                .andWhere("LOWER(COALESCE(a.Status, '')) NOT IN ('cancelled', 'canceled', 'rejected')")
                .orderBy("a.AppointmentDate", "DESC")
                .getOne();

            if (treatedAppointment) {
                // Verify doctor is linked to the hospital
                let isLinked = true;
                if (treatedAppointment.HospitalId) {
                    const hp = await this.providerRepo.findOne({
                        where: { UserId: doctorId, HospitalId: treatedAppointment.HospitalId, IsDeleted: false }
                    });
                    isLinked = !!hp;
                }

                if (isLinked) {
                    return {
                        hasAccess: true,
                        status: "APPROVED",
                        treated: true,
                        hospitalId: treatedAppointment.HospitalId,
                        consent: consent || null,
                        durationLabel: "Treating Doctor (Hospital Linked)"
                    };
                }
            }
        } catch (treatmentCheckError) {
            console.error("[checkAccess] Treatment check error:", treatmentCheckError);
        }

        return {
            hasAccess: false,
            status: consent ? consent.Status : "NO_REQUEST",
            consent: consent || null,
            durationLabel: consent ? this.getDurationLabel(consent.Duration) : undefined
        };
    }

    /**
     * Whether someone working at a hospital may read the records created there
     * without the patient's consent. They may when they are on that hospital's
     * staff and the patient has booked an appointment there or is registered
     * with it. When an appointment is given, its hospital is used.
     */
    async checkHospitalRecordAccess(
        patientId: string,
        requesterId: string,
        scope: { hospitalId?: number; appointmentId?: number }
    ): Promise<{ allowed: boolean; hospitalId?: number; reason?: string }> {
        if (!patientId || !requesterId) return { allowed: false, reason: "MISSING_IDS" };
        const { Appointment } = await import("../../../../models/Appointments/appointment.model.js");
        const appointmentRepo = AppDataSource.getRepository(Appointment);

        let hospitalId = scope.hospitalId && scope.hospitalId > 0 ? scope.hospitalId : undefined;
        if (scope.appointmentId) {
            const appt = await appointmentRepo.findOne({ where: { Id: scope.appointmentId } });
            if (!appt || String(appt.UserId).toUpperCase() !== patientId.toUpperCase()) {
                return { allowed: false, reason: "APPOINTMENT_NOT_FOR_PATIENT" };
            }
            if (hospitalId && Number(appt.HospitalId) !== hospitalId) {
                return { allowed: false, reason: "APPOINTMENT_OTHER_HOSPITAL" };
            }
            hospitalId = Number(appt.HospitalId) || undefined;
        }
        if (!hospitalId) return { allowed: false, reason: "NO_HOSPITAL" };

        // Staff of the hospital: a provider profile there, or any role there.
        const isProvider = await this.providerRepo.count({
            where: { UserId: requesterId, HospitalId: hospitalId, IsDeleted: false },
        });
        const isStaff = isProvider > 0 || (await AppDataSource.getRepository(UserRole).count({
            where: { UserId: requesterId, HospitalId: hospitalId, IsDeleted: false },
        })) > 0;
        if (!isStaff) return { allowed: false, hospitalId, reason: "NOT_HOSPITAL_STAFF" };

        // The patient's relationship with the hospital: an appointment or a registration.
        const booked = await appointmentRepo.createQueryBuilder("a")
            .where("a.UserId = :patientId", { patientId })
            .andWhere("a.HospitalId = :hospitalId", { hospitalId })
            .andWhere("LOWER(COALESCE(a.Status, '')) NOT IN ('cancelled', 'canceled', 'rejected')")
            .getCount();
        if (booked > 0) return { allowed: true, hospitalId };

        const registered = await AppDataSource.getRepository(PatientRegistration).count({
            where: { UserId: patientId, HospitalId: hospitalId, IsDeleted: false },
        });
        if (registered > 0) return { allowed: true, hospitalId };

        return { allowed: false, hospitalId, reason: "PATIENT_NOT_AT_HOSPITAL" };
    }

    /**
     * The patient gives a doctor on Yira access to all their records, without
     * waiting for the doctor to ask. Replaces any earlier request between them.
     */
    async grantAccess(patientId: string, doctorId: string, duration: string = "7_DAYS", hospitalId?: number): Promise<any> {
        if (!patientId || !doctorId) throw new Error("patientId and doctorId are required");
        const doctor = await this.userRepo.findOne({ where: { Id: doctorId, IsDeleted: false } });
        if (!doctor) throw new Error("Doctor not found");
        const isProvider = await this.providerRepo.count({ where: { UserId: doctorId, IsDeleted: false } });
        if (isProvider === 0) throw new Error("This person is not a doctor on Yira");

        const durationMinutes = this.getDurationMinutes(duration);
        const now = new Date();
        let consent = await this.consentRepo.findOne({
            where: { PatientId: patientId, DoctorId: doctorId },
            order: { Id: "DESC" },
        });
        if (!consent) {
            consent = this.consentRepo.create({ PatientId: patientId, DoctorId: doctorId, RequestedAt: now });
        }
        consent.Duration = duration;
        consent.DurationMinutes = durationMinutes;
        consent.Status = "APPROVED";
        consent.ApprovedAt = now;
        consent.ExpiresAt = durationMinutes > 0 ? new Date(now.getTime() + durationMinutes * 60 * 1000) : undefined;
        if (hospitalId) consent.HospitalId = hospitalId;
        consent.Notes = "Shared by patient";
        consent.UpdatedAt = now;
        const saved = await this.consentRepo.save(consent);
        return { ...saved, durationLabel: this.getDurationLabel(saved.Duration) };
    }

    /**
     * Retrieves all consent requests for a patient with full doctor and hospital details.
     */
    async getPatientConsents(patientId: string): Promise<any[]> {
        if (!patientId) {
            return [];
        }

        const consents = await this.consentRepo.find({
            where: { PatientId: patientId },
            order: { RequestedAt: "DESC" }
        });

        const now = new Date();
        const results = [];

        for (const c of consents) {
            // Auto expire check
            if (c.Status === "APPROVED" && c.DurationMinutes > 0 && c.ExpiresAt && c.ExpiresAt < now) {
                c.Status = "EXPIRED";
                c.UpdatedAt = now;
                await this.consentRepo.save(c);
            }

            const doctorUser = await this.userRepo.findOne({ where: { Id: c.DoctorId } });
            const provider = await this.providerRepo.findOne({
                where: { UserId: c.DoctorId, IsDeleted: false },
                relations: ["Hospital"]
            });

            let hospitalName = provider?.Hospital?.Name || "Main Clinic Facility";
            if (c.HospitalId) {
                const hosp = await this.hospitalRepo.findOne({ where: { Id: c.HospitalId } });
                if (hosp?.Name) hospitalName = hosp.Name;
            }

            const docFullName = `${doctorUser?.FirstName || ""} ${doctorUser?.LastName || ""}`.trim();
            const doctorName = docFullName
                ? (docFullName.toLowerCase().startsWith("dr.") ? docFullName : `Dr. ${docFullName}`)
                : "Dr. Healthcare Provider";

            let remainingMinutes: number | null = null;
            if (c.Status === "APPROVED" && c.ExpiresAt) {
                remainingMinutes = Math.max(0, Math.floor((c.ExpiresAt.getTime() - now.getTime()) / (1000 * 60)));
            }

            results.push({
                id: c.Id,
                patientId: c.PatientId,
                doctorId: c.DoctorId,
                doctorName,
                doctorPhoto: doctorUser?.ImagePath || null,
                doctorEmail: doctorUser?.Email || "",
                doctorPhone: doctorUser?.PhoneNumber || "",
                specialty: provider?.Specialty || "General Practitioner",
                qualification: provider?.Qualification || "MBBS",
                hospitalId: c.HospitalId || provider?.HospitalId || 0,
                hospitalName,
                duration: c.Duration,
                durationLabel: this.getDurationLabel(c.Duration),
                durationMinutes: c.DurationMinutes,
                status: c.Status,
                requestedAt: c.RequestedAt,
                approvedAt: c.ApprovedAt,
                expiresAt: c.ExpiresAt,
                remainingMinutes,
                notes: c.Notes
            });
        }

        return results;
    }

    /**
     * Patient approves, rejects, or revokes a doctor access request.
     */
    async respondToConsent(consentId: number, patientId: string, action: "APPROVE" | "REJECT" | "REVOKE"): Promise<any> {
        const consent = await this.consentRepo.findOne({
            where: { Id: consentId }
        });

        if (!consent) {
            throw new Error("Consent request not found");
        }

        if (patientId && consent.PatientId !== patientId) {
            throw new Error("Unauthorized to respond to this consent");
        }

        const now = new Date();

        if (action === "APPROVE") {
            consent.Status = "APPROVED";
            consent.ApprovedAt = now;
            if (consent.DurationMinutes > 0) {
                consent.ExpiresAt = new Date(now.getTime() + consent.DurationMinutes * 60 * 1000);
            } else {
                consent.ExpiresAt = undefined; // Never expires
            }
        } else if (action === "REJECT") {
            consent.Status = "REJECTED";
            consent.ApprovedAt = undefined;
            consent.ExpiresAt = undefined;
        } else if (action === "REVOKE") {
            consent.Status = "REVOKED";
            consent.ExpiresAt = now;
        }

        consent.UpdatedAt = now;
        const saved = await this.consentRepo.save(consent);
        return {
            ...saved,
            durationLabel: this.getDurationLabel(saved.Duration)
        };
    }

    /**
     * Connects patient and doctor via QR Code scan.
     * Grants automatic approved record access and registers the patient under doctor's patient list.
     */
    async connectPatientByQr(
        patientUserId: string,
        doctorId: string,
        hospitalId?: number,
        orgId?: number,
        patientDetails?: {
            phone?: string;
            name?: string;
            email?: string;
            gender?: string;
        }
    ): Promise<any> {
        if (!patientUserId && !patientDetails?.phone) {
            throw new Error("Patient ID or phone number is required");
        }
        if (!doctorId) {
            throw new Error("Doctor ID is required");
        }

        const userRoleRepo = AppDataSource.getRepository(UserRole);
        const patientRegRepo = AppDataSource.getRepository(PatientRegistration);

        let targetPatient: User | null = null;
        if (patientUserId) {
            targetPatient = await this.userRepo.findOne({ where: { Id: patientUserId, IsDeleted: false } }).catch(() => null);
        }
        if (!targetPatient && patientDetails?.phone) {
            const clean = patientDetails.phone.replace(/[^\d]/g, "").slice(-10);
            targetPatient = await this.userRepo.createQueryBuilder("u")
                .where("u.IsDeleted = 0")
                .andWhere("(u.PhoneNumber = :p OR u.PhoneNumber LIKE :l)", { p: patientDetails.phone, l: `%${clean}` })
                .getOne()
                .catch(() => null);
        }

        if (!targetPatient && patientDetails?.phone) {
            targetPatient = new User();
            targetPatient.Id = uuidv4();
            targetPatient.IsPrimary = true;
            targetPatient.Relation = "Self";
            const nameParts = (patientDetails.name || "Patient").trim().split(/\s+/);
            targetPatient.FirstName = nameParts[0] || "Patient";
            targetPatient.LastName = nameParts.slice(1).join(" ") || "";
            targetPatient.PhoneNumber = patientDetails.phone;
            targetPatient.Email = patientDetails.email || "";
            if (patientDetails.gender) targetPatient.Gender = patientDetails.gender;
            targetPatient.Status = true;
            targetPatient.IsDeleted = false;
            await this.userRepo.save(targetPatient);
        }

        if (!targetPatient) {
            throw new Error("Could not find or create patient user");
        }

        const hId = hospitalId || 19;
        const oId = orgId || 1;

        // Ensure Patient Role mapping exists
        const existingRole = await userRoleRepo.findOne({
            where: { UserId: targetPatient.Id, OrganizationId: oId, HospitalId: hId, IsDeleted: false }
        }).catch(() => null);
        if (!existingRole) {
            const roleRepo = AppDataSource.getRepository(Role);
            const patientRole = await roleRepo.findOne({ where: { RoleName: "Patient" } }).catch(() => null);
            const userRole = new UserRole();
            userRole.UserId = targetPatient.Id;
            userRole.RoleId = patientRole ? patientRole.Id : "4FC67429-28AE-4106-93EF-436228282ED0";
            userRole.OrganizationId = oId;
            userRole.HospitalId = hId;
            userRole.Status = true;
            userRole.IsDeleted = false;
            await userRoleRepo.save(userRole).catch(() => {});
        }

        // Ensure PatientRegistration mapping exists
        let existingReg = await patientRegRepo.findOne({
            where: { UserId: targetPatient.Id, OrganizationId: oId, HospitalId: hId, IsDeleted: false }
        }).catch(() => null);
        if (!existingReg) {
            const patientReg = new PatientRegistration();
            patientReg.UserId = targetPatient.Id;
            patientReg.OrganizationId = oId;
            patientReg.HospitalId = hId;
            patientReg.Status = true;
            patientReg.IsDeleted = false;
            await patientRegRepo.save(patientReg).catch(() => {});
        }

        // Create or update approved consent for 30 days
        let consent = await this.consentRepo.findOne({
            where: { PatientId: targetPatient.Id, DoctorId: doctorId },
            order: { Id: "DESC" }
        }).catch(() => null);

        const now = new Date();
        const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

        if (consent) {
            consent.Status = "APPROVED";
            consent.ApprovedAt = now;
            consent.ExpiresAt = expires;
            consent.Duration = "1_MONTH";
            consent.DurationMinutes = 43200;
            consent.Notes = "Connected via Doctor QR Scan";
            consent.HospitalId = hId;
            consent.OrganizationId = oId;
            consent.UpdatedAt = now;
            await this.consentRepo.save(consent);
        } else {
            consent = new PatientAccessConsent();
            consent.PatientId = targetPatient.Id;
            consent.DoctorId = doctorId;
            consent.HospitalId = hId;
            consent.OrganizationId = oId;
            consent.Duration = "1_MONTH";
            consent.DurationMinutes = 43200;
            consent.Status = "APPROVED";
            consent.RequestedAt = now;
            consent.ApprovedAt = now;
            consent.ExpiresAt = expires;
            consent.Notes = "Connected via Doctor QR Scan";
            await this.consentRepo.save(consent);
        }

        return {
            status: true,
            message: "Patient successfully connected with doctor via QR code",
            patient: {
                id: targetPatient.Id,
                name: `${targetPatient.FirstName || ''} ${targetPatient.LastName || ''}`.trim(),
                phone: targetPatient.PhoneNumber,
            },
            consent
        };
    }
}

export const patientAccessConsentService = new PatientAccessConsentService();
