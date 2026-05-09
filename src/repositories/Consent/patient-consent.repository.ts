import { AppDataSource } from "../../config/database.js";
import { PatientConsent } from "../../models/Consent/patient-consent.model.js";

export class PatientConsentRepository {
    private repo = AppDataSource.getRepository(PatientConsent);

    async create(data: Partial<PatientConsent>): Promise<PatientConsent> {
        const consent = this.repo.create(data);
        return await this.repo.save(consent);
    }

    async findByAppointment(appointmentId: number): Promise<PatientConsent[]> {
        return await this.repo.find({
            where: { AppointmentId: appointmentId },
            relations: ["Template"]
        });
    }

    async findByDate(date: string, hospitalId: number): Promise<PatientConsent[]> {
        // Join with Appointment to filter by HospitalId
        return await this.repo.createQueryBuilder("pc")
            .innerJoinAndSelect("pc.Appointment", "appointment")
            .leftJoinAndSelect("pc.Template", "template")
            .leftJoinAndSelect("appointment.User", "user")
            .where("appointment.HospitalId = :hospitalId", { hospitalId })
            .andWhere("CAST(pc.CreatedAt AS DATE) = :date", { date })
            .getMany();
    }

    async updateStatus(id: number, status: string, signedUrl?: string): Promise<void> {
        await this.repo.update(id, {
            Status: status,
            SignedAt: status === "Signed" ? new Date() : undefined,
            SignedPdfUrl: signedUrl,
            UpdatedAt: new Date()
        });
    }
}

export const patientConsentRepository = new PatientConsentRepository();
