import { AppDataSource } from "../../../../config/database.js";
import { In } from "typeorm/index.js";
import { PatientAccessConsent } from "../../../../models/Consent/patient-access-consent.model.js";
import { User } from "../../../../models/Account/user.model.js";
import { UserRole } from "../../../../models/Account/userrole.model.js";
import { Role } from "../../../../models/Account/role.model.js";
import { PatientRegistration } from "../../../../models/Organizations/patient-registration.model.js";
import { HealthcareProvider } from "../../../../models/Organizations/healthcare-provider.model.js";
import { Hospital } from "../../../../models/Organizations/hospital.model.js";
import { isHospitalStaff } from "../../../../utils/hospital-admin-access.js";

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
     * The number an access OTP goes to: the patient's own, or for a family member without one,
     * their account holder's (family members share the main number).
     */
    private async otpContactFor(patientId: string): Promise<{ phone: string; countryCode: string } | null> {
        const patient = await this.userRepo.findOne({ where: { Id: patientId, IsDeleted: false } });
        if (!patient) return null;
        let holder: User | null = patient;
        if (!String(patient.PhoneNumber || "").replace(/\D/g, "") && patient.ParentUserId) {
            holder = await this.userRepo.findOne({ where: { Id: patient.ParentUserId, IsDeleted: false } });
        }
        const phone = String(holder?.PhoneNumber || "").replace(/\D/g, "");
        if (!phone) return null;
        return { phone, countryCode: String(holder?.CountryCode || "91").replace(/\D/g, "") || "91" };
    }

    /**
     * A doctor with the patient in front of him asks for access by OTP: a code goes to the
     * patient's phone (SMS in India, WhatsApp elsewhere) and the doctor types what they read out.
     * Only for the doctor's own patients (he treats them, or they visit his hospital), so the
     * button can't be used to send codes to strangers.
     */
    async sendAccessOtp(patientId: string, doctorId: string, hospitalId?: number): Promise<{ sessionId: string; sentTo: string }> {
        if (!patientId || !doctorId) throw new Error("patientId and doctorId are required");
        const isProvider = await this.providerRepo.count({ where: { UserId: doctorId, IsDeleted: false } });
        if (isProvider === 0) throw new Error("Only doctors can ask for access.");
        const access = await this.checkAccess(patientId, doctorId);
        const hospitalAccess = hospitalId
            ? await this.checkHospitalRecordAccess(patientId, doctorId, { hospitalId })
            : { allowed: false };
        if (!access.hasAccess && !access.treated && !hospitalAccess.allowed) {
            throw new Error("You can ask for access by OTP only for patients who visit you or your hospital.");
        }
        const contact = await this.otpContactFor(patientId);
        if (!contact) throw new Error("This patient has no mobile number to send the OTP to.");

        const { otpService } = await import("../../../../services/Account/otp.service.js");
        const { OTPPurpose } = await import("../../../../enums/OTPType.enum.js");
        const channel = contact.countryCode === "91" ? "sms" : "whatsapp";
        const sent = await otpService.sendOTP(contact.phone, OTPPurpose.SENSITIVE_OPERATION, contact.countryCode, undefined, undefined, channel);
        const last4 = contact.phone.slice(-4);
        return { sessionId: sent.sessionId, sentTo: `+${contact.countryCode} ••••${last4}` };
    }

    /** Checks the OTP the patient read out and, when right, gives this doctor access for [duration]. */
    async verifyAccessOtp(
        patientId: string,
        doctorId: string,
        sessionId: string,
        otp: string,
        duration: string = "7_DAYS",
        hospitalId?: number
    ): Promise<any> {
        if (!patientId || !doctorId || !sessionId || !otp) throw new Error("patientId, sessionId and otp are required");
        const contact = await this.otpContactFor(patientId);
        if (!contact) throw new Error("This patient has no mobile number to check the OTP against.");
        const { otpService } = await import("../../../../services/Account/otp.service.js");
        const { OTPPurpose } = await import("../../../../enums/OTPType.enum.js");
        const result = await otpService.verifyOTP(contact.phone, sessionId, String(otp).trim(), OTPPurpose.SENSITIVE_OPERATION, contact.countryCode);
        if (!result?.success) throw new Error(result?.message || "That OTP is not right. Please check and try again.");
        return this.grantAccess(patientId, doctorId, duration, hospitalId);
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
                    // Treating a patient is not access to their whole history: the doctor sees his
                    // own consultations, and everything else only once the patient grants access
                    // (OTP, approving the request, or sharing from their app). `treated` lets the
                    // apps say "your patient" without opening other doctors' records.
                    return {
                        hasAccess: false,
                        status: consent ? consent.Status : "NO_REQUEST",
                        treated: true,
                        hospitalId: treatedAppointment.HospitalId,
                        consent: consent || null,
                        durationLabel: consent ? this.getDurationLabel(consent.Duration) : undefined
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

        // Staff of the hospital. Not any role there: every patient registered with it has a Patient role.
        if (!(await isHospitalStaff(requesterId, hospitalId))) return { allowed: false, hospitalId, reason: "NOT_HOSPITAL_STAFF" };

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

        // The doctors, their provider rows and the hospitals of all consents, read once for the
        // whole list (this used to be up to three queries per consent, one after another). A doctor
        // with several provider rows gets the one with the lowest Id; findOne took one in no set order.
        const sameId = (id: unknown) => String(id ?? "").toUpperCase();
        const doctorIds = [...new Set(consents.map(c => c.DoctorId).filter(Boolean))];
        const hospitalIds = [...new Set(consents.map(c => c.HospitalId).filter(Boolean))];
        const [doctorUsers, doctorProviders, hospitals] = await Promise.all([
            doctorIds.length ? this.userRepo.find({ where: { Id: In(doctorIds) } }) : Promise.resolve([] as User[]),
            doctorIds.length
                ? this.providerRepo.find({
                    where: { UserId: In(doctorIds), IsDeleted: false },
                    relations: ["Hospital"],
                    order: { Id: "ASC" }
                })
                : Promise.resolve([] as HealthcareProvider[]),
            hospitalIds.length ? this.hospitalRepo.find({ where: { Id: In(hospitalIds) } }) : Promise.resolve([] as Hospital[]),
        ]);
        const doctorUserById = new Map(doctorUsers.map(u => [sameId(u.Id), u]));
        const providerByDoctor = new Map<string, HealthcareProvider>();
        for (const p of doctorProviders) {
            if (!providerByDoctor.has(sameId(p.UserId))) providerByDoctor.set(sameId(p.UserId), p);
        }
        const hospitalById = new Map(hospitals.map(h => [Number(h.Id), h]));

        for (const c of consents) {
            // Auto expire check
            if (c.Status === "APPROVED" && c.DurationMinutes > 0 && c.ExpiresAt && c.ExpiresAt < now) {
                c.Status = "EXPIRED";
                c.UpdatedAt = now;
                await this.consentRepo.save(c);
            }

            const doctorUser = doctorUserById.get(sameId(c.DoctorId)) ?? null;
            const provider = providerByDoctor.get(sameId(c.DoctorId)) ?? null;

            let hospitalName = provider?.Hospital?.Name || "Main Clinic Facility";
            if (c.HospitalId) {
                const hosp = hospitalById.get(Number(c.HospitalId));
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
        orgId?: number
    ): Promise<any> {
        if (!patientUserId) {
            throw new Error("Patient ID is required");
        }
        if (!doctorId) {
            throw new Error("Doctor ID is required");
        }

        const userRoleRepo = AppDataSource.getRepository(UserRole);
        const patientRegRepo = AppDataSource.getRepository(PatientRegistration);

        // The patient must already exist: this used to find or create one from any phone number sent.
        const targetPatient = await this.userRepo.findOne({ where: { Id: patientUserId, IsDeleted: false } });
        if (!targetPatient) {
            throw new Error("We couldn't find your account. Please sign in again.");
        }

        // A QR can hold the provider's number instead of the doctor's user id.
        if (/^\d+$/.test(String(doctorId).trim())) {
            const byNumber = await this.providerRepo.findOne({ where: { Id: Number(doctorId), IsDeleted: false } });
            if (byNumber) doctorId = byNumber.UserId;
        }
        // The doctor's own hospital decides where the patient is registered, not the request.
        const worksAt = await this.providerRepo.find({ where: { UserId: doctorId, IsDeleted: false } });
        if (worksAt.length === 0) {
            throw new Error("This person is not a doctor on Yira");
        }
        const hId = Number((worksAt.find((p) => Number(p.HospitalId) === Number(hospitalId)) ?? worksAt[0]).HospitalId);
        const hospital = await this.hospitalRepo.findOne({ where: { Id: hId } });
        const oId = Number(hospital?.OrganizationId) || orgId || 1;

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
