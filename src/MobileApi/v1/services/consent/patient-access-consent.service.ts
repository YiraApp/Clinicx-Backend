import { AppDataSource } from "../../../../config/database.js";
import { PatientAccessConsent } from "../../../../models/Consent/patient-access-consent.model.js";
import { User } from "../../../../models/Account/user.model.js";
import { HealthcareProvider } from "../../../../models/Organizations/healthcare-provider.model.js";
import { Hospital } from "../../../../models/Organizations/hospital.model.js";

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

        if (!consent) {
            return { hasAccess: false, status: "NO_REQUEST", consent: null };
        }

        const now = new Date();

        if (consent.Status === "APPROVED") {
            // Check if expired
            if (consent.DurationMinutes > 0 && consent.ExpiresAt && consent.ExpiresAt < now) {
                consent.Status = "EXPIRED";
                consent.UpdatedAt = now;
                await this.consentRepo.save(consent);
                return {
                    hasAccess: false,
                    status: "EXPIRED",
                    consent,
                    durationLabel: this.getDurationLabel(consent.Duration)
                };
            }

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

        return {
            hasAccess: false,
            status: consent.Status, // PENDING, REJECTED, EXPIRED, REVOKED
            consent,
            durationLabel: this.getDurationLabel(consent.Duration)
        };
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
}

export const patientAccessConsentService = new PatientAccessConsentService();
